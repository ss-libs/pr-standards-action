#!/usr/bin/env node

/**
 * PR Standards Checker
 *
 * This script analyzes a pull request against team standards and posts findings as a comment.
 * It uses AWS Bedrock's Claude Opus 4.5 model to perform the analysis.
 */

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration from environment variables
const PR_NUMBER = process.env.PR_NUMBER;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const AWS_REGION = process.env.BEDROCK_REGION || 'us-east-1';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '16000', 10);
const MODEL_ID = process.env.MODEL_ID || 'arn:aws:bedrock:us-east-1:257394448189:inference-profile/us.anthropic.claude-opus-4-6-v1';
const FAILURE_MODE = process.env.FAILURE_MODE || 'fail';
const NONCOMPLIANT_LABEL = process.env.NONCOMPLIANT_LABEL || 'Noncompliant';

// Determine paths - use custom if provided, otherwise use defaults from action
const ACTION_DEFAULTS_DIR = path.join(__dirname, '..', 'defaults');
const STANDARDS_PATH = process.env.STANDARDS_FILE || path.join(ACTION_DEFAULTS_DIR, 'PR_STANDARDS.md');
const IGNORE_CONFIG_PATH = process.env.IGNORE_CONFIG_FILE || path.join(ACTION_DEFAULTS_DIR, 'standards-checker-ignore.json');

/**
 * Load ignore configuration
 */
function loadIgnoreConfig() {
  try {
    if (fs.existsSync(IGNORE_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(IGNORE_CONFIG_PATH, 'utf8'));
      return config;
    }
  } catch (error) {
    console.warn('⚠️  Could not load ignore config, using defaults');
  }

  // Default config
  return {
    ignorePatterns: ['node_modules/**', 'dist/**', 'build/**', '*.min.js'],
    ignoreComment: 'standards-checker-ignore'
  };
}

const IGNORE_CONFIG = loadIgnoreConfig();

/**
 * Check if a file should be ignored based on ignore patterns
 */
function shouldIgnoreFile(filePath) {
  const { ignorePatterns } = IGNORE_CONFIG;

  for (const pattern of ignorePatterns) {
    // Simple glob pattern matching
    const regex = new RegExp(
      '^' + pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*') + '$'
    );

    if (regex.test(filePath)) {
      return true;
    }
  }

  return false;
}

/**
 * Remove ignored sections from file content
 */
function filterIgnoredContent(content, filePath) {
  const { ignoreComment } = IGNORE_CONFIG;
  const lines = content.split('\n');
  const filteredLines = [];
  let ignoring = false;
  let ignoredRanges = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for ignore-start comment
    if (line.includes(`${ignoreComment}-start`)) {
      ignoring = true;
      const startLine = i + 1;
      ignoredRanges.push({ start: startLine });
      continue;
    }

    // Check for ignore-end comment
    if (line.includes(`${ignoreComment}-end`)) {
      ignoring = false;
      if (ignoredRanges.length > 0) {
        ignoredRanges[ignoredRanges.length - 1].end = i + 1;
      }
      continue;
    }

    // Check for single-line ignore comment
    if (line.includes(ignoreComment) && !line.includes(`${ignoreComment}-start`) && !line.includes(`${ignoreComment}-end`)) {
      ignoredRanges.push({ start: i + 1, end: i + 1 });
      filteredLines.push(`// Line ${i + 1} ignored by standards checker`);
      continue;
    }

    if (!ignoring) {
      filteredLines.push(line);
    } else {
      // Replace ignored lines with placeholder
      filteredLines.push(`// Line ${i + 1} ignored by standards checker`);
    }
  }

  return {
    content: filteredLines.join('\n'),
    ignoredRanges: ignoredRanges.length > 0 ? ignoredRanges : null
  };
}

/**
 * Get the Claude Opus model to use
 * Using cross-region inference profile for better availability and on-demand support
 */
async function getLatestClaudeOpusModel() {
  console.log(`✓ Using Claude model: ${MODEL_ID}`);
  return MODEL_ID;
}

/**
 * Get PR details including files changed
 */
async function getPRDetails() {
  try {
    const details = execSync(
      `gh pr view ${PR_NUMBER} --repo ${REPO} --json title,body,files,additions,deletions,baseRefName,headRefName`,
      { encoding: 'utf8' }
    );
    return JSON.parse(details);
  } catch (error) {
    console.error('Error fetching PR details:', error.message);
    throw error;
  }
}

/**
 * Get the full diff for the PR
 */
async function getPRDiff() {
  try {
    const diff = execSync(`gh pr diff ${PR_NUMBER} --repo ${REPO}`, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024, // 20MB buffer
    });
    return diff;
  } catch (error) {
    console.error('Error fetching PR diff:', error.message);
    throw error;
  }
}

/**
 * Get full content of changed files
 */
async function getChangedFileContents(files) {
  const fileContents = {};

  for (const file of files) {
    const filePath = file.path;

    // Only get contents for source files, skip large files and non-source files
    if (shouldIncludeFile(filePath)) {
      try {
        const content = execSync(`git show HEAD:${filePath}`, {
          encoding: 'utf8',
          maxBuffer: 5 * 1024 * 1024,
        });

        // Filter out ignored sections
        const { content: filteredContent, ignoredRanges } = filterIgnoredContent(content, filePath);

        fileContents[filePath] = {
          content: filteredContent,
          additions: file.additions,
          deletions: file.deletions,
          ignoredRanges: ignoredRanges
        };
      } catch (error) {
        // File might be new or deleted, skip
        console.log(`  ⚠️  Couldn't fetch ${filePath}: ${error.message}`);
      }
    }
  }

  return fileContents;
}

/**
 * Determine if file should be included in analysis
 */
function shouldIncludeFile(filePath) {
  const includedExtensions = ['.js', '.ts', '.tsx', '.jsx', '.json', '.sql', '.yml', '.yaml'];
  const excludedPaths = ['node_modules/', 'dist/', 'build/', 'coverage/', 'package-lock.json'];

  const hasIncludedExt = includedExtensions.some(ext => filePath.endsWith(ext));
  const hasExcludedPath = excludedPaths.some(excluded => filePath.includes(excluded));

  // Check custom ignore patterns
  const isIgnored = shouldIgnoreFile(filePath);

  return hasIncludedExt && !hasExcludedPath && !isIgnored;
}

/**
 * Get related files for context (e.g., if controller changed, get model, routes, etc.)
 */
async function getRelatedFiles(changedFiles) {
  const relatedFiles = {};

  for (const file of changedFiles) {
    const filePath = file.path;
    const related = findRelatedFiles(filePath);

    for (const relatedPath of related) {
      if (!relatedFiles[relatedPath] && fs.existsSync(relatedPath)) {
        try {
          const content = fs.readFileSync(relatedPath, 'utf8');
          // Only include if reasonable size
          if (content.length < 100000) {
            relatedFiles[relatedPath] = content;
          }
        } catch (error) {
          // Skip files we can't read
        }
      }
    }
  }

  return relatedFiles;
}

/**
 * Find related files based on file path patterns
 */
function findRelatedFiles(filePath) {
  const related = [];

  // Controllers -> Models, Routes
  if (filePath.includes('src/controllers/')) {
    const baseName = path.basename(filePath, path.extname(filePath));
    related.push(`src/models/${baseName}.ts`);
    related.push(`src/routes/${baseName}.ts`);
    related.push(`src/validators/${baseName}.ts`);
  }

  // Models -> Controllers
  if (filePath.includes('src/models/')) {
    const baseName = path.basename(filePath, path.extname(filePath));
    related.push(`src/controllers/${baseName}.ts`);
  }

  // Routes -> Controllers, Validators
  if (filePath.includes('src/routes/')) {
    const baseName = path.basename(filePath, path.extname(filePath));
    related.push(`src/controllers/${baseName}.ts`);
    related.push(`src/validators/${baseName}.ts`);
  }

  // Migrations -> Related models
  if (filePath.includes('db/migrations/')) {
    // Try to infer table name from migration filename
    const filename = path.basename(filePath);
    const match = filename.match(/_(.*?)\.ts$/);
    if (match) {
      const tableName = match[1];
      // Try common model name patterns
      const singularName = tableName.replace(/s$/, ''); // Simple singularization
      related.push(`src/models/${singularName}.ts`);
      related.push(`src/models/${tableName}.ts`);
    }
  }

  return related;
}

/**
 * Get examples of similar patterns in the codebase
 */
async function getCodebasePatterns(changedFiles) {
  const patterns = {};

  // Look for patterns based on what files are changing
  const hasControllers = changedFiles.some(f => f.path.includes('src/controllers/'));
  const hasModels = changedFiles.some(f => f.path.includes('src/models/'));
  const hasRoutes = changedFiles.some(f => f.path.includes('src/routes/'));
  const hasMigrations = changedFiles.some(f => f.path.includes('db/migrations/'));

  // Get example patterns from existing code
  if (hasControllers) {
    patterns.controllerExample = getExampleFile('src/controllers');
  }

  if (hasModels) {
    patterns.modelExample = getExampleFile('src/models');
  }

  if (hasRoutes) {
    patterns.routeExample = getExampleFile('src/routes');
  }

  if (hasMigrations) {
    patterns.migrationExample = getExampleFile('db/migrations');
  }

  return patterns;
}

/**
 * Get an example file from a directory
 */
function getExampleFile(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return null;

    const files = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
      .slice(0, 1); // Just get one example

    if (files.length > 0) {
      const filePath = path.join(dirPath, files[0]);
      const content = fs.readFileSync(filePath, 'utf8');

      // Return truncated version if too large
      if (content.length > 5000) {
        return content.slice(0, 5000) + '\n... (truncated)';
      }
      return content;
    }
  } catch (error) {
    // Ignore errors
  }

  return null;
}

/**
 * Get directory structure for context
 */
function getDirectoryStructure() {
  try {
    const tree = execSync('find src -type f -name "*.ts" -o -name "*.js" | head -100', {
      encoding: 'utf8',
    });
    return tree;
  } catch (error) {
    return null;
  }
}

/**
 * Call Claude Opus to analyze the PR
 */
async function analyzeWithClaude(prDetails, diff, fileContents, relatedFiles, patterns, modelId, previousComment) {
  const client = new BedrockRuntimeClient({
    region: AWS_REGION,
    credentials: {
      accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY,
    },
  });

  const prompt = buildAnalysisPrompt(prDetails, diff, fileContents, relatedFiles, patterns, previousComment);

  try {
    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    };

    const command = new InvokeModelCommand({
      modelId: modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    });

    console.log(`  🤖 Calling ${modelId}...`);
    const response = await client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));

    return responseBody.content[0].text;
  } catch (error) {
    console.error('Error calling Bedrock:', error);
    console.error(`Model ID used: ${modelId}`);

    if (error.message && error.message.includes('on-demand throughput')) {
      console.error('\n⚠️  This model does not support on-demand throughput.');
      console.error('The model selection logic may need to be updated.');
      console.error('Consider using a different model or inference profile.\n');
    }

    throw error;
  }
}

/**
 * Build the analysis prompt with all context
 */
function buildAnalysisPrompt(prDetails, diff, fileContents, relatedFiles, patterns, previousComment) {
  const standardsNote = `You have access to the team standards document at .github/PR_STANDARDS.md. Reference it as the authoritative source for all standards.`;

  let prompt = `You are a senior code reviewer. Review this pull request against the team coding standards and identify issues.

${standardsNote}

## PR Information

**Title:** ${prDetails.title}
**Description:** ${prDetails.body || 'No description provided'}
**Base Branch:** ${prDetails.baseRefName}
**Head Branch:** ${prDetails.headRefName}
**Files Changed:** ${prDetails.files?.length || 0}
**Additions:** +${prDetails.additions || 0}
**Deletions:** -${prDetails.deletions || 0}

## Changed Files Summary

${prDetails.files?.map(f => `- ${f.path} (+${f.additions || 0}/-${f.deletions || 0})`).join('\n') || 'No files'}

## Pull Request Diff

\`\`\`diff
${diff.slice(0, 100000)}${diff.length > 100000 ? '\n... (diff truncated, see full files below)' : ''}
\`\`\`
`;

  // Add full file contents for better context
  if (Object.keys(fileContents).length > 0) {
    prompt += `\n## Full File Contents (After Changes)\n\n`;
    for (const [filePath, fileData] of Object.entries(fileContents)) {
      prompt += `### ${filePath}\n`;
      if (fileData.ignoredRanges) {
        prompt += `**Note:** Lines ${fileData.ignoredRanges.map(r => r.start === r.end ? r.start : `${r.start}-${r.end}`).join(', ')} are marked as ignored and should not be reviewed.\n\n`;
      }
      prompt += `\`\`\`typescript\n${fileData.content.slice(0, 20000)}\n\`\`\`\n\n`;
    }
  }

  // Add related files for context
  if (Object.keys(relatedFiles).length > 0) {
    prompt += `\n## Related Files (For Context)\n\n`;
    for (const [filePath, content] of Object.entries(relatedFiles)) {
      prompt += `### ${filePath}\n\`\`\`typescript\n${content.slice(0, 10000)}\n\`\`\`\n\n`;
    }
  }

  // Add pattern examples
  if (Object.keys(patterns).length > 0) {
    prompt += `\n## Existing Codebase Patterns (For Reference)\n\n`;
    for (const [type, example] of Object.entries(patterns)) {
      if (example) {
        prompt += `### Example ${type}\n\`\`\`typescript\n${example}\n\`\`\`\n\n`;
      }
    }
  }

  // Add previous review comment for context on re-reviews
  if (previousComment) {
    prompt += `\n## Previous Review Comment\n\nThe following is the most recent automated standards check comment on this PR. Use it to distinguish between persisting issues and new ones:\n\n${previousComment}\n\n`;
  }

  prompt += `
## Ignored Code Sections

Some code sections are marked with \`${IGNORE_CONFIG.ignoreComment}\` comments. These sections should **NOT** be reviewed or reported as issues. Ignore markers can be:
- \`${IGNORE_CONFIG.ignoreComment}-start\` / \`${IGNORE_CONFIG.ignoreComment}-end\` - Multi-line ignore block
- \`${IGNORE_CONFIG.ignoreComment}\` - Single line ignore

In the file contents above, ignored lines are replaced with \`// Line X ignored by standards checker\` placeholders. **Do not report any issues for these lines.**

## Your Task

Review this PR against the team standards in .github/PR_STANDARDS.md. Focus on:

1. **Security Issues** - SQL injection, auth/authz, token handling, input validation
2. **Performance Problems** - N+1 queries, O(N) operations that should be O(1), memory issues
3. **Code Quality** - Naming, organization, duplication, commented code
4. **API Design** - RESTful patterns, error handling, i18n usage, validators
5. **Database Standards** - Query optimization, transactions, migrations
6. **Pattern Consistency** - Does the code follow existing patterns shown above?

## Priority Groups

Classify each issue into one of two groups:

**🔴 Must Fix** (blocks merge):
- SQL injection vulnerabilities
- Missing authentication/authorization
- Data loss risks in migrations
- Transaction cleanup issues (rollback missing)
- Hardcoded credentials or sensitive data
- Direct file uploads to backend server (should use signed URLs)
- Local filesystem dependencies that break in Docker/K8s
- Individual database operations in loops instead of bulk operations (for large datasets)
- Operations that cannot handle large data volumes (10k+ records)
- N+1 query patterns
- Missing validators on endpoints

**🟡 Other** (notable but does not block merge):
- Hardcoded error messages (not using i18n)
- Missing pagination on list endpoints
- PUT instead of PATCH for partial updates
- Code in wrong directory (models vs services)
- File naming violations (non-camelCase)
- Use of \`any\` type instead of proper TypeScript types
- New JavaScript files (.js) instead of TypeScript (.ts)
- Missing function parameter or return type annotations
- Commented code blocks
- Minor naming improvements
- console.log instead of logger

${previousComment ? `
This is a RE-REVIEW. A previous standards check comment is provided above.

Output your findings as a single JSON code block and nothing else. Use exactly this schema:

\`\`\`json
{
  "status": "BLOCK_MERGE or APPROVED",
  "summary": "1-2 sentence overall assessment",
  "persisting": [
    {
      "priority": "must_fix or other",
      "title": "Title matching an issue from the previous review",
      "path": "src/file.ts",
      "line": 42
    }
  ],
  "new_findings": [
    {
      "priority": "must_fix or other",
      "title": "Short descriptive title (max 8 words)",
      "path": "src/file.ts",
      "line": 42,
      "body": "Concise explanation. Must-fix findings should include a corrected code snippet in a markdown fenced block."
    }
  ],
  "resolved": ["Title of each issue from the previous review that has been fixed"]
}
\`\`\`

Rules:
- Output ONLY the JSON code block — no prose before or after
- \`persisting\`: ONLY include issues from the previous review that are STILL PRESENT — title and location, no body needed
- \`new_findings\`: ONLY issues NOT mentioned in the previous review, with full \`body\` explanation
- \`path\` must exactly match a file path from the Changed Files Summary above
- \`line\` must be a line number in the NEW version of the file that appears in the diff
- Only report issues on lines that were added or modified in this PR
- Set \`status\` to \`BLOCK_MERGE\` if any \`must_fix\` issues exist (persisting or new)
- Omit empty arrays from the output
` : `
Output your findings as a single JSON code block and nothing else. Use exactly this schema:

\`\`\`json
{
  "status": "BLOCK_MERGE or APPROVED",
  "summary": "1-2 sentence overall assessment",
  "findings": [
    {
      "priority": "must_fix or other",
      "title": "Short descriptive title (max 8 words)",
      "path": "src/controllers/user.ts",
      "line": 42,
      "body": "Concise explanation. Must-fix findings should include a corrected code snippet in a markdown fenced block."
    }
  ]
}
\`\`\`

Rules:
- Output ONLY the JSON code block — no prose before or after
- \`path\` must exactly match a file path from the Changed Files Summary above
- \`line\` must be a line number in the NEW version of the file that appears in the diff
- Only report issues on lines that were added or modified in this PR
- Set \`status\` to \`BLOCK_MERGE\` if any \`must_fix\` findings exist
- Omit empty arrays from the output
`}
`;

  return prompt;
}

/**
 * Extract priority counts from the analysis
 */
function extractPriorityCounts(analysis) {
  // Extract counts from summary section
  const highMatch = analysis.match(/High Priority Issues:\s*(\d+)/);
  const mediumMatch = analysis.match(/Medium Priority Issues:\s*(\d+)/);
  const lowMatch = analysis.match(/Low Priority Issues:\s*(\d+)/);

  const highPriorityCount = highMatch ? parseInt(highMatch[1], 10) : 0;
  const mediumPriorityCount = mediumMatch ? parseInt(mediumMatch[1], 10) : 0;
  const lowPriorityCount = lowMatch ? parseInt(lowMatch[1], 10) : 0;

  // Also check for explicit priority markers as backup
  const highPriorityMarkers = (analysis.match(/🔴 HIGH|Priority:\*\* 🔴 HIGH/g) || []).length;
  const mediumPriorityMarkers = (analysis.match(/🟡 MEDIUM|Priority:\*\* 🟡 MEDIUM/g) || []).length;
  const lowPriorityMarkers = (analysis.match(/🟢 LOW|Priority:\*\* 🟢 LOW/g) || []).length;

  // Check for "BLOCK MERGE" action
  const shouldBlock = analysis.includes('BLOCK MERGE') ||
                      analysis.includes('Action Required:** BLOCK MERGE');

  // Total all issues
  const totalIssues = Math.max(
    highPriorityCount + mediumPriorityCount + lowPriorityCount,
    highPriorityMarkers + mediumPriorityMarkers + lowPriorityMarkers
  );

  return {
    highPriorityCount: Math.max(highPriorityCount, highPriorityMarkers),
    mediumPriorityCount: Math.max(mediumPriorityCount, mediumPriorityMarkers),
    lowPriorityCount: Math.max(lowPriorityCount, lowPriorityMarkers),
    totalIssues,
    shouldBlock,
  };
}

/**
 * Post comment to PR
 */
async function postComment(comment, modelId) {
  // Add model ID to comment
  const commentWithModel = comment.replace(
    '[Model ID will be shown]',
    modelId || 'Unknown'
  );

  // Write comment to temporary file to avoid command injection
  const tempFile = path.join('/tmp', `pr-comment-${Date.now()}.md`);

  try {
    fs.writeFileSync(tempFile, commentWithModel, 'utf8');

    execSync(
      `gh pr comment ${PR_NUMBER} --repo ${REPO} --body-file "${tempFile}"`,
      { encoding: 'utf8' }
    );

    console.log('✅ Successfully posted PR standards check comment');

    // Clean up temp file
    fs.unlinkSync(tempFile);
  } catch (error) {
    // Clean up temp file on error
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    console.error('Error posting comment:', error.message);
    throw error;
  }
}

/**
 * Post a success comment to the PR
 */
async function postSuccessComment(modelId) {
  const body =
    `# ✅ PR Standards Check Passed\n\n` +
    `PR #${PR_NUMBER} meets all team standards. No issues found.\n\n` +
    `*🤖 Automated review using AI. Model: ${modelId}. Human review still required for final approval.*`;
  await postComment(body, null);
}

/**
 * Fetch the body of the most recent standards check comment, if any
 */
async function getPreviousCheckComment() {
  try {
    const output = execSync(
      `gh pr view ${PR_NUMBER} --repo ${REPO} --json comments --jq '[.comments[] | select(.author.login == "github-actions") | select(.body | contains("PR Standards Check"))] | last | .body'`,
      { encoding: 'utf8' }
    );
    const body = output.trim();
    if (!body || body === 'null') return null;
    return body;
  } catch (error) {
    console.warn('⚠️  Could not fetch previous check comment:', error.message);
    return null;
  }
}

/**
 * Remove the noncompliant label from the PR if it is present
 */
async function removeLabelIfPresent() {
  try {
    execSync(
      `gh pr edit ${PR_NUMBER} --repo ${REPO} --remove-label "${NONCOMPLIANT_LABEL}"`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
    console.log(`🏷️  Removed "${NONCOMPLIANT_LABEL}" label from PR #${PR_NUMBER}`);
  } catch {
    // Label wasn't present or couldn't be removed — not an error
  }
}

/**
 * Parse a unified diff and return a Map<filePath, Set<lineNumber>> of lines
 * that are valid targets for RIGHT-side inline review comments.
 */
function parseDiffForValidLines(diff) {
  const validLines = new Map();
  let currentFile = null;
  let newLineNum = 0;

  for (const line of diff.split('\n')) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!validLines.has(currentFile)) validLines.set(currentFile, new Set());
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLineNum = parseInt(hunkMatch[1], 10) - 1;
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      newLineNum++;
      validLines.get(currentFile).add(newLineNum);
    } else if (line.startsWith(' ')) {
      newLineNum++;
      validLines.get(currentFile).add(newLineNum);
    }
    // deleted lines (-) don't advance newLineNum and can't receive RIGHT-side comments
  }

  return validLines;
}

/**
 * Extract and parse the JSON block from Claude's response.
 * Returns the parsed object, or null if extraction/parsing fails.
 */
function parseAnalysisJSON(rawText) {
  const match = rawText.match(/```json\n([\s\S]*?)\n```/);
  if (!match) {
    console.warn('⚠️  No JSON block found in analysis response');
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    console.warn('⚠️  Could not parse JSON from analysis:', e.message);
    return null;
  }
}

/**
 * Count issues from a parsed analysis object.
 */
function countIssues(data) {
  const all = [
    ...(data.findings || []),
    ...(data.persisting || []),
    ...(data.new_findings || []),
  ];
  const mustFix = all.filter(f => f.priority === 'must_fix').length;
  const other = all.filter(f => f.priority === 'other').length;
  return {
    highPriorityCount: mustFix,
    mediumPriorityCount: other,
    lowPriorityCount: 0,
    totalIssues: all.length,
    shouldBlock: data.status === 'BLOCK_MERGE',
  };
}

/**
 * Build the markdown body for the PR review (used as the top-level review comment).
 * Findings that could not be placed inline are included here with full details.
 */
function buildReviewBody(data, isReReview, modelId, unplaceable) {
  const priorityIcon = p => p === 'must_fix' ? '🔴' : '🟡';
  let body = isReReview ? '# 🔍 PR Standards Check (Re-review)\n\n' : '# 🔍 PR Standards Check\n\n';

  if (data.summary) body += `${data.summary}\n\n`;

  if (isReReview) {
    if (data.persisting?.length) {
      body += `## ⏳ Still Open\n\n`;
      for (const f of data.persisting) {
        body += `${priorityIcon(f.priority)} **${f.title}** (\`${f.path}:${f.line}\`)\n`;
      }
      body += '\n';
    }
    if (data.new_findings?.length) {
      body += `## 🆕 New Issues\n\n`;
      for (const f of data.new_findings) {
        body += `${priorityIcon(f.priority)} **${f.title}** (\`${f.path}:${f.line}\`)\n`;
      }
      body += '\n';
    }
    if (data.resolved?.length) {
      body += `## ✅ Resolved\n\n`;
      for (const r of data.resolved) body += `- ${r}\n`;
      body += '\n';
    }
  } else {
    for (const [label, icon, p] of [['Must Fix', '🔴', 'must_fix'], ['Other', '🟡', 'other']]) {
      const group = (data.findings || []).filter(f => f.priority === p);
      if (group.length) {
        body += `## ${icon} ${label}\n\n`;
        for (const f of group) body += `- **${f.title}** (\`${f.path}:${f.line}\`)\n`;
        body += '\n';
      }
    }
  }

  // Findings that couldn't be placed inline get full details here
  if (unplaceable.length) {
    body += `## ⚠️ Additional Findings (lines not in diff)\n\n`;
    for (const f of unplaceable) {
      body += `### ${priorityIcon(f.priority)} ${f.title} (\`${f.path}:${f.line}\`)\n\n${f.body || f.title}\n\n`;
    }
  }

  const statusEmoji = { BLOCK_MERGE: '🚫', APPROVED: '✅' }[data.status] || '❓';
  body += `**Status:** ${statusEmoji} ${(data.status || 'UNKNOWN').replace('_', ' ')}\n\n`;
  body += `> Detailed findings are posted as inline comments on the relevant lines.\n\n`;
  body += `*🤖 Automated review using AI. Model: ${modelId}. Human review still required for final approval.*`;

  return body;
}

/**
 * Post a PR review with inline comments for each finding, falling back to the
 * review body for any findings whose line numbers are not in the diff.
 */
async function postReview(data, diff, modelId, isReReview) {
  const validLines = parseDiffForValidLines(diff);

  const allFindings = isReReview
    ? [
        ...(data.persisting || []).map(f => ({ ...f, inlineBody: `⏳ **Still open:** ${f.title}` })),
        ...(data.new_findings || []).map(f => ({ ...f, inlineBody: f.body })),
      ]
    : (data.findings || []).map(f => ({ ...f, inlineBody: f.body }));

  const inlineComments = [];
  const unplaceable = [];

  for (const finding of allFindings) {
    const fileLines = validLines.get(finding.path);
    if (fileLines && fileLines.has(finding.line)) {
      const icon = finding.priority === 'must_fix' ? '🔴' : '🟡';
      inlineComments.push({
        path: finding.path,
        line: finding.line,
        side: 'RIGHT',
        body: `${icon} **${finding.title}**\n\n${finding.inlineBody}`,
      });
    } else {
      unplaceable.push(finding);
    }
  }

  console.log(`  ✓ ${inlineComments.length} inline comment(s), ${unplaceable.length} fallback to review body`);

  const reviewBody = buildReviewBody(data, isReReview, modelId, unplaceable);
  const reviewPayload = { body: reviewBody, event: 'COMMENT', comments: inlineComments };

  const tempFile = path.join('/tmp', `pr-review-${Date.now()}.json`);
  try {
    fs.writeFileSync(tempFile, JSON.stringify(reviewPayload), 'utf8');
    execSync(
      `gh api repos/${REPO}/pulls/${PR_NUMBER}/reviews --method POST --input "${tempFile}"`,
      { encoding: 'utf8' }
    );
    console.log(`✅ Posted review with ${inlineComments.length} inline comment(s)`);
    fs.unlinkSync(tempFile);
  } catch (error) {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    throw error;
  }
}

/**
 * Add a label to the PR, creating it on the repo if it doesn't exist
 */
async function addNoncompliantLabel() {
  try {
    execSync(
      `gh label create "${NONCOMPLIANT_LABEL}" --repo ${REPO} --color "B60205" --description "PR does not meet quality standards" --force`,
      { encoding: 'utf8' }
    );
    execSync(
      `gh pr edit ${PR_NUMBER} --repo ${REPO} --add-label "${NONCOMPLIANT_LABEL}"`,
      { encoding: 'utf8' }
    );
    console.log(`🏷️  Added "${NONCOMPLIANT_LABEL}" label to PR #${PR_NUMBER}`);
  } catch (error) {
    console.error(`⚠️  Could not add label: ${error.message}`);
  }
}

/**
 * Main execution
 */
async function main() {
  console.log(`🔍 Checking PR #${PR_NUMBER} against team standards...\n`);

  if (!GITHUB_TOKEN) {
    console.error('❌ GITHUB_TOKEN environment variable is required');
    process.exit(1);
  }

  if (!process.env.BEDROCK_AWS_ACCESS_KEY_ID || !process.env.BEDROCK_AWS_SECRET_ACCESS_KEY) {
    console.error('❌ AWS Bedrock credentials are required');
    process.exit(1);
  }

  try {
    // Fetch previous check comment for re-review context
    console.log('🔍 Checking for previous review comments...');
    const previousComment = await getPreviousCheckComment();
    if (previousComment) {
      console.log('ℹ️  Previous review found — will compare against it');
    }

    // Get the latest Claude Opus model
    console.log('🔍 Fetching latest Claude Opus model...');
    const modelId = await getLatestClaudeOpusModel();

    // Gather all context
    console.log('📥 Fetching PR details...');
    const prDetails = await getPRDetails();

    console.log('📥 Fetching PR diff...');
    const diff = await getPRDiff();

    console.log('📄 Fetching changed file contents...');
    const fileContents = await getChangedFileContents(prDetails.files || []);
    console.log(`  ✓ Retrieved ${Object.keys(fileContents).length} file(s)`);

    console.log('🔗 Fetching related files for context...');
    const relatedFiles = await getRelatedFiles(prDetails.files || []);
    console.log(`  ✓ Retrieved ${Object.keys(relatedFiles).length} related file(s)`);

    console.log('📚 Gathering codebase patterns...');
    const patterns = await getCodebasePatterns(prDetails.files || []);
    console.log(`  ✓ Retrieved ${Object.keys(patterns).filter(k => patterns[k]).length} pattern example(s)`);

    // Analyze with Claude
    console.log('\n🤖 Analyzing PR with Claude...');
    const rawAnalysis = await analyzeWithClaude(prDetails, diff, fileContents, relatedFiles, patterns, modelId, previousComment);

    // Parse the structured JSON response
    const analysisData = parseAnalysisJSON(rawAnalysis);
    if (!analysisData) {
      throw new Error('Analysis did not return a parseable JSON response');
    }

    // Post review with inline comments
    console.log('💬 Posting review with inline comments...');
    const isReReview = !!previousComment;
    await postReview(analysisData, diff, modelId, isReReview);

    console.log('✅ PR standards check complete!\n');

    const { highPriorityCount, mediumPriorityCount, lowPriorityCount, totalIssues, shouldBlock } = countIssues(analysisData);

    // Check for ANY issues
    if (totalIssues > 0 || shouldBlock) {
      console.error(`\n❌ STANDARDS VIOLATIONS FOUND:`);
      if (highPriorityCount > 0) {
        console.error(`   🔴 HIGH Priority:   ${highPriorityCount} issue(s)`);
      }
      if (mediumPriorityCount > 0) {
        console.error(`   🟡 MEDIUM Priority: ${mediumPriorityCount} issue(s)`);
      }
      if (lowPriorityCount > 0) {
        console.error(`   🟢 LOW Priority:    ${lowPriorityCount} issue(s)`);
      }
      console.error(`   📊 TOTAL:           ${totalIssues} issue(s)\n`);
      console.error('📋 Review the posted comment for details\n');

      if (FAILURE_MODE === 'label') {
        await addNoncompliantLabel();
        console.log('ℹ️  Pipeline continues (failure-mode: label)\n');
      } else {
        console.error('❌ PR does not meet quality standards - all issues must be resolved');
        process.exit(1); // Exit with error code to fail the workflow
      }
    } else {
      console.log('\n✅ No issues found - PR meets all quality standards\n');
      await postSuccessComment(modelId);
      await removeLabelIfPresent();
    }
  } catch (error) {
    console.error('❌ Error during PR standards check:', error.message);

    // Post a fallback comment indicating the check failed
    try {
      await postComment(
        '## PR Standards Check\n\n' +
        '⚠️ The automated PR standards check encountered an error and could not complete.\n\n' +
        'Please ensure a human reviewer checks this PR against our [team standards](.github/PR_STANDARDS.md).\n\n' +
        `Error: ${error.message}`
      );
    } catch (commentError) {
      console.error('Failed to post error comment:', commentError.message);
    }

    process.exit(1);
  }
}

main();
