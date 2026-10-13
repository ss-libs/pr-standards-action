#!/usr/bin/env node

/**
 * PR Standards Checker
 *
 * This script analyzes a pull request against team standards and posts findings as a comment.
 * It uses AWS Bedrock's Claude Opus 4.5 model to perform the analysis.
 */

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { execFileSync, execSync } = require('child_process');
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
const REVIEW_HEADING_PREFIX = '# 🔍 PR Standards Check';

const isBotLogin = login => login === 'github-actions[bot]' || login === 'github-actions';
const isCommitSha = value => /^[a-f0-9]{40}$/i.test(value || '');

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
 * Load the standards document content
 */
function loadStandards() {
  try {
    if (fs.existsSync(STANDARDS_PATH)) {
      return fs.readFileSync(STANDARDS_PATH, 'utf8');
    }
  } catch (error) {
    console.warn('⚠️  Could not load standards file:', error.message);
  }
  return null;
}

const STANDARDS_CONTENT = loadStandards();

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
      `gh pr view ${PR_NUMBER} --repo ${REPO} --json title,body,files,additions,deletions,baseRefName,headRefName,headRefOid`,
      { encoding: 'utf8' }
    );
    return JSON.parse(details);
  } catch (error) {
    console.error('Error fetching PR details:', error.message);
    throw error;
  }
}

async function getCurrentPRHeadSha() {
  const details = execSync(
    `gh pr view ${PR_NUMBER} --repo ${REPO} --json headRefOid`,
    { encoding: 'utf8' }
  );
  return JSON.parse(details).headRefOid;
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
async function getChangedFileContents(files, extraPaths = [], headSha = 'HEAD') {
  const fileContents = {};
  const requestedFiles = new Map(files.map(file => [file.path, file]));
  for (const filePath of extraPaths) {
    if (!requestedFiles.has(filePath)) requestedFiles.set(filePath, { path: filePath, additions: 0, deletions: 0 });
  }
  execFileSync('git', ['cat-file', '-e', `${headSha}^{commit}`], { stdio: 'ignore' });

  for (const file of requestedFiles.values()) {
    const filePath = file.path;

    // Only get contents for source files, skip large files and non-source files
    if (shouldIncludeFile(filePath)) {
      try {
        const content = execFileSync('git', ['show', `${headSha}:${filePath}`], {
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
        if (extraPaths.includes(filePath)) {
          try {
            execFileSync('git', ['cat-file', '-e', `${headSha}:${filePath}`], { stdio: 'ignore' });
            throw error;
          } catch (existenceError) {
            if (existenceError === error) throw error;
            fileContents[filePath] = {
              content: '[File does not exist at the reviewed PR head]',
              additions: file.additions,
              deletions: file.deletions,
              ignoredRanges: null,
            };
          }
        } else {
          console.log(`  ⚠️  Couldn't fetch ${filePath}: ${error.message}`);
        }
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
async function analyzeWithClaude(prDetails, diff, fileContents, relatedFiles, patterns, modelId, reviewThreads, resolvedThreads = [], incrementalDiff = null, isReReview = false) {
  const client = new BedrockRuntimeClient({
    region: AWS_REGION,
    credentials: {
      accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY,
    },
  });

  const prompt = buildAnalysisPrompt(prDetails, diff, fileContents, relatedFiles, patterns, reviewThreads, resolvedThreads, incrementalDiff, isReReview);

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
function buildAnalysisPrompt(prDetails, diff, fileContents, relatedFiles, patterns, reviewThreads, resolvedThreads = [], incrementalDiff = null, isReReview = false) {
  let prompt = `You are a code standards enforcer. Your only job is to identify violations of the team standards documented below.

**Critical rules — read before doing anything else:**
- Only report violations that are **explicitly described** in the Team Standards below.
- Do **not** flag general best practices, style preferences, or code quality concerns that are not specifically named in the standards.
- Do **not** leave any comment, observation, or note about code that looks correct, acceptable, or is simply not a violation. Silence is correct when there is no violation.
- Do **not** make positive observations ("this looks good", "well structured", etc.). Output nothing for acceptable code.

## Team Standards

${STANDARDS_CONTENT || '*Standards file could not be loaded. Flag nothing — do not invent standards.*'}

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

  // Add existing open inline review threads (with user replies) for re-review context
  if (reviewThreads?.length > 0) {
    prompt += `\n## Existing Open Inline Review Comment Threads\n\n`;
    prompt += `The following are unresolved inline review comments from previous standards checks. `;
    prompt += `Each thread may include replies from the PR author or other reviewers.\n\n`;
    for (const thread of reviewThreads) {
      prompt += `### Thread ID: \`${thread.threadId}\` — "${thread.botTitle}" (\`${thread.path}:${thread.line}\`)\n\n`;
      prompt += `**Bot comment:**\n${thread.botBody}\n\n`;
      if (thread.userReplies.length > 0) {
        prompt += `**User replies:**\n`;
        for (const reply of thread.userReplies) {
          prompt += `- @${reply.author}: ${reply.body}\n`;
        }
        prompt += '\n';
      } else {
        prompt += `*No user replies yet.*\n\n`;
      }
    }
  }

  // Add previously resolved threads so Claude doesn't re-raise already-addressed issues
  if (resolvedThreads.length > 0) {
    prompt += `\n## Previously Resolved Inline Review Threads\n\n`;
    prompt += `The following issues were previously raised and have been **closed** `;
    prompt += `(either fixed in code or the explanation was accepted). `;
    prompt += `Do **NOT** raise these again under any circumstances — closed threads are permanently off-limits.\n\n`;
    for (const thread of resolvedThreads) {
      prompt += `- Thread ID \`${thread.threadId}\`: **"${thread.botTitle}"** (\`${thread.path}:${thread.line}\`)\n`;
    }
    prompt += '\n';
  }

  prompt += `
## Ignored Code Sections

Some code sections are marked with \`${IGNORE_CONFIG.ignoreComment}\` comments. These sections should **NOT** be reviewed or reported as issues. Ignore markers can be:
- \`${IGNORE_CONFIG.ignoreComment}-start\` / \`${IGNORE_CONFIG.ignoreComment}-end\` - Multi-line ignore block
- \`${IGNORE_CONFIG.ignoreComment}\` - Single line ignore

In the file contents above, ignored lines are replaced with \`// Line X ignored by standards checker\` placeholders. **Do not report any issues for these lines.**

## Your Task

Review only the changed code in the diff above. Report ONLY violations that are explicitly described in the Team Standards above. If something is not addressed by the standards, do not mention it.

## Priority Classification

Classify each violation based on how the standards document treats it:

**🔴 Must Fix** (blocks merge): Violations the standards identify as blocking — typically security issues, data loss risks, or critical correctness problems.

**🟡 Other** (does not block merge): Standards violations that are notable but not blocking.

`;

  if (isReReview) {
    const newFindingScopeRule = incrementalDiff === null
      ? '- `new_findings`: issues on added lines in the full Pull Request Diff above; if an issue is already covered by an open thread, put it in `persisting`, never `new_findings`\n- `line` must be a line number in the NEW version of the file that appears as an addition in the full Pull Request Diff'
      : incrementalDiff === ''
        ? '- `new_findings` must be empty because the reviewed head is unchanged'
        : '- `new_findings`: issues on lines from the Incremental Diff above ONLY; if an issue is already covered by an open thread, put it in `persisting`, never `new_findings`\n- `line` must be a line number in the NEW version of the file that appears as an addition in the incremental diff';
    if (incrementalDiff === '') {
      prompt += `## Incremental Diff (New Code Since Last Review)\n\n`;
      prompt += `There is no new code since the last review. \`new_findings\` **must be empty** — do not open new threads on pre-existing code.\n\n`;
    } else if (incrementalDiff !== null) {
      prompt += `## Incremental Diff (New Code Since Last Review)\n\n`;
      prompt += `The following diff contains ONLY the code added since the last review was conducted. `;
      prompt += `\`new_findings\` must reference ONLY lines that appear as additions (\`+\`) in this incremental diff.\n\n`;
      prompt += `\`\`\`diff\n${incrementalDiff.slice(0, 60000)}${incrementalDiff.length > 60000 ? '\n... (truncated)' : ''}\n\`\`\`\n\n`;
    } else {
      prompt += `## Incremental Diff (New Code Since Last Review)\n\n`;
      prompt += `The incremental comparison is unavailable. Use additions in the full Pull Request Diff above for \`new_findings\`.\n\n`;
    }

    prompt += `This is a RE-REVIEW. Open inline comment threads from previous checks are listed above.

For each existing thread, evaluate:
1. Is the underlying issue still present in the current code?
2. If the user replied, does their explanation legitimately justify the pattern?

Output your findings as a single JSON code block and nothing else. Use exactly this schema:

\`\`\`json
{
  "status": "BLOCK_MERGE or APPROVED",
  "summary": "1-2 sentence overall assessment",
  "persisting": [
    {
      "thread_id": "Exact Thread ID listed above",
      "priority": "must_fix or other",
      "title": "Title exactly matching an existing thread listed above",
      "path": "src/file.ts",
      "line": 42,
      "bump_message": "Optional: 1 sentence explaining why this is still an issue (include if user replied but explanation was insufficient)"
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
  "resolved": [{"thread_id": "Exact Thread ID where the code was fixed", "title": "Existing thread title"}],
  "accepted_explanations": [{"thread_id": "Exact Thread ID whose explanation is valid", "title": "Existing thread title"}],
  "general_notes": ["Any concern about the PR itself — title, description, missing context — that is not tied to a specific code line"]
}
\`\`\`

Rules:
- Output ONLY the JSON code block — no prose before or after
- Every \`persisting\`, \`resolved\`, and \`accepted_explanations\` entry must copy the exact \`thread_id\` listed above
- \`persisting\`: issues from existing threads that are STILL PRESENT and NOT adequately explained
${newFindingScopeRule}
- \`resolved\`: existing threads where the underlying code was fixed (regardless of user replies)
- \`accepted_explanations\`: existing threads where the user's reply is a legitimate justification even though the pattern remains
- \`general_notes\`: PR-level concerns (bad title, missing description, etc.) — do NOT include issues that can be tied to a specific file and line
- \`path\` must exactly match a file path from the Changed Files Summary above
- Set \`status\` to \`BLOCK_MERGE\` if any \`must_fix\` issues exist in \`persisting\` or \`new_findings\`
- Omit empty arrays from the output
`;
  } else {
    prompt += `Output your findings as a single JSON code block and nothing else. Use exactly this schema:

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
  ],
  "general_notes": ["Any concern about the PR itself — title, description, missing context — that is not tied to a specific code line"]
}
\`\`\`

Rules:
- Output ONLY the JSON code block — no prose before or after
- \`path\` must exactly match a file path from the Changed Files Summary above
- \`line\` must be a line number in the NEW version of the file that appears in the diff
- Only report issues on lines that were added or modified in this PR
- \`general_notes\`: PR-level concerns (bad title, missing description, etc.) — do NOT include issues that can be tied to a specific file and line
- Set \`status\` to \`BLOCK_MERGE\` if any \`must_fix\` findings exist
- Omit empty arrays from the output
`;
  }

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
 * Post general PR-level notes (title, description issues, etc.) as a plain
 * conversation comment rather than inline on a code file.
 */
async function postGeneralNotes(notes, modelId) {
  if (!notes || notes.length === 0) return;

  let body = `## 📋 PR Standards — General Notes\n\n`;
  for (const note of notes) {
    body += `- ${note}\n`;
  }
  body += `\n*🤖 Automated review using AI. Model: ${modelId}. Human review still required for final approval.*`;

  await postComment(body, null);
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
 * Run a GraphQL query/mutation against the GitHub API.
 * Writes the request to a temp file to avoid shell-escaping issues.
 */
function runGraphQL(query, variables = {}) {
  const tempFile = path.join('/tmp', `graphql-${Date.now()}.json`);
  try {
    fs.writeFileSync(tempFile, JSON.stringify({ query, variables }), 'utf8');
    // Use 'gh api -X POST graphql' (not 'gh api graphql') so the full JSON body
    // including variables is POSTed directly without subcommand pre-processing.
    const result = execSync(`gh api -X POST graphql --input "${tempFile}"`, { encoding: 'utf8' });
    fs.unlinkSync(tempFile);
    const parsed = JSON.parse(result);
    // GitHub GraphQL always returns HTTP 200; actual failures appear in 'errors'.
    if (parsed.errors && parsed.errors.length > 0) {
      throw new Error(parsed.errors.map(e => e.message).join('; '));
    }
    return parsed;
  } catch (error) {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    throw error;
  }
}

function getRemainingThreadComments(threadId, cursor) {
  const query = `
    query($threadId: ID!, $cursor: String) {
      node(id: $threadId) {
        ... on PullRequestReviewThread {
          comments(first: 100, after: $cursor) {
            nodes {
              databaseId
              body
              createdAt
              author { login }
              commit { oid }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  const comments = [];
  let nextCursor = cursor;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = runGraphQL(query, { threadId, cursor: nextCursor });
    const connection = data.data?.node?.comments;
    if (!connection) throw new Error(`Review thread ${threadId} disappeared while loading comments`);
    comments.push(...(connection.nodes || []));
    hasNextPage = connection.pageInfo?.hasNextPage === true;
    nextCursor = connection.pageInfo?.endCursor || null;
  }

  return comments;
}

/**
 * Fetch the complete standards-checker review state. Pagination is required here:
 * treating an incomplete or failed read as "no previous review" creates duplicate threads.
 */
async function getReviewState() {
  const [owner, repoName] = REPO.split('/');
  const threadQuery = `
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $cursor) {
            nodes {
              id
              isResolved
              path
              line
              comments(first: 100) {
                nodes {
                  databaseId
                  body
                  createdAt
                  author { login }
                  commit { oid }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  const threads = [];
  let threadCursor = null;
  let hasMoreThreads = true;

  while (hasMoreThreads) {
    const data = runGraphQL(threadQuery, {
      owner,
      repo: repoName,
      number: parseInt(PR_NUMBER, 10),
      cursor: threadCursor,
    });
    const connection = data.data?.repository?.pullRequest?.reviewThreads;
    if (!connection) throw new Error('Pull request review threads were not returned by GitHub');

    for (const thread of (connection.nodes || [])) {
      const comments = thread.comments?.nodes || [];
      if (thread.comments?.pageInfo?.hasNextPage) {
        comments.push(...getRemainingThreadComments(thread.id, thread.comments.pageInfo.endCursor));
      }
      threads.push({ ...thread, comments: { nodes: comments } });
    }

    hasMoreThreads = connection.pageInfo?.hasNextPage === true;
    threadCursor = connection.pageInfo?.endCursor || null;
  }

  const reviewQuery = `
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviews(first: 100, after: $cursor) {
            nodes {
              body
              submittedAt
              author { login }
              commit { oid }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  const checkerReviews = [];
  let reviewCursor = null;
  let hasMoreReviews = true;

  while (hasMoreReviews) {
    const data = runGraphQL(reviewQuery, {
      owner,
      repo: repoName,
      number: parseInt(PR_NUMBER, 10),
      cursor: reviewCursor,
    });
    const connection = data.data?.repository?.pullRequest?.reviews;
    if (!connection) throw new Error('Pull request reviews were not returned by GitHub');
    checkerReviews.push(...(connection.nodes || []).filter(review => (
      isBotLogin(review.author?.login) && review.body?.startsWith(REVIEW_HEADING_PREFIX)
    )));
    hasMoreReviews = connection.pageInfo?.hasNextPage === true;
    reviewCursor = connection.pageInfo?.endCursor || null;
  }

  const botThreads = threads.filter(thread => {
    const first = thread.comments?.nodes?.[0];
    return first && isBotLogin(first.author?.login);
  });

  const mapThread = thread => {
    const comments = thread.comments?.nodes || [];
    const botComment = comments[0];
    const replies = comments.slice(1);
    const titleMatch = botComment.body.match(/[🔴🟡]\s*\*\*(.*?)\*\*/);
    return {
      threadId: thread.id,
      firstCommentId: botComment.databaseId,
      firstCommentCreatedAt: botComment.createdAt,
      firstCommentCommitSha: botComment.commit?.oid || null,
      path: thread.path,
      line: thread.line,
      botTitle: titleMatch ? titleMatch[1].trim() : 'Unknown Issue',
      botBody: botComment.body,
      userReplies: replies.filter(reply => !isBotLogin(reply.author?.login)).map(reply => ({
        author: reply.author?.login || 'unknown',
        body: reply.body,
        createdAt: reply.createdAt,
      })),
      botReplies: replies.filter(reply => isBotLogin(reply.author?.login)).map(reply => ({
        body: reply.body,
        createdAt: reply.createdAt,
      })),
    };
  };

  checkerReviews.sort((a, b) => (a.submittedAt || '').localeCompare(b.submittedAt || ''));
  const latestReview = checkerReviews[checkerReviews.length - 1];
  const latestThread = botThreads
    .map(mapThread)
    .sort((a, b) => (a.firstCommentCreatedAt || '').localeCompare(b.firstCommentCreatedAt || ''))
    .at(-1);

  return {
    open: botThreads.filter(thread => !thread.isResolved).map(mapThread),
    resolved: botThreads.filter(thread => thread.isResolved).map(mapThread),
    latestReviewCommitSha: latestReview?.commit?.oid || latestThread?.firstCommentCommitSha || null,
    hasPreviousReview: checkerReviews.length > 0 || botThreads.length > 0,
  };
}

/**
 * Get the diff between the exact commit previously reviewed and the inspected PR head.
 * Returns the diff string (possibly empty if no new commits), or null on error.
 */
async function getIncrementalDiff(reviewedCommitSha, headSha) {
  if (!reviewedCommitSha) return null;
  if (!isCommitSha(reviewedCommitSha) || !isCommitSha(headSha)) {
    throw new Error('Cannot compute incremental diff from invalid commit identifiers');
  }
  if (reviewedCommitSha === headSha) {
    console.log('  ℹ️  PR head is unchanged since the last review — new findings scope is empty');
    return '';
  }

  try {
    console.log(`  ℹ️  Incremental diff: ${reviewedCommitSha.slice(0, 7)}..${headSha.slice(0, 7)}`);
    return execSync(
      `gh api "repos/${REPO}/compare/${reviewedCommitSha}...${headSha}" -H "Accept: application/vnd.github.v3.diff"`,
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
    );
  } catch (error) {
    console.warn('⚠️  Incremental comparison unavailable; using the full PR diff:', error.message);
    return null;
  }
}

/**
 * Resolve an inline review thread via GraphQL.
 */
async function resolveReviewThread(threadId) {
  const mutation = `
    mutation($id: ID!) {
      resolveReviewThread(input: { threadId: $id }) {
        thread { isResolved }
      }
    }
  `;
  try {
    const result = runGraphQL(mutation, { id: threadId });
    if (result.data?.resolveReviewThread?.thread?.isResolved === true) {
      console.log(`  ✓ Resolved thread ${threadId}`);
      return true;
    } else {
      console.warn(`  ⚠️  resolveReviewThread returned unexpected response for ${threadId}:`, JSON.stringify(result));
      return false;
    }
  } catch (error) {
    console.warn(`  ⚠️  Could not resolve thread ${threadId}:`, error.message);
    return false;
  }
}

/**
 * Post a reply to an existing inline review comment.
 */
async function replyToReviewComment(commentId, body) {
  const tempFile = path.join('/tmp', `pr-reply-${Date.now()}.json`);
  try {
    fs.writeFileSync(tempFile, JSON.stringify({ body }), 'utf8');
    execSync(
      `gh api repos/${REPO}/pulls/${PR_NUMBER}/comments/${commentId}/replies --method POST --input "${tempFile}"`,
      { encoding: 'utf8' }
    );
    console.log(`  ✓ Replied to comment ${commentId}`);
    fs.unlinkSync(tempFile);
    return true;
  } catch (error) {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    console.warn(`  ⚠️  Could not reply to comment ${commentId}:`, error.message);
    return false;
  }
}

/**
 * Resolve a model result back to one GitHub thread. Stable IDs are authoritative;
 * exact title/path matching is only a compatibility fallback for older responses.
 */
function findMatchingThread(threads, reference, filePath = null) {
  const hasExplicitThreadId = typeof reference === 'object' && Boolean(reference?.thread_id);
  const threadId = hasExplicitThreadId ? reference.thread_id : reference;
  const idMatch = threads.find(thread => thread.threadId === threadId);
  if (idMatch) return idMatch;
  if (hasExplicitThreadId) return null;

  const title = typeof reference === 'object' ? reference?.title : reference;
  if (!title) return null;
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  const matches = threads.filter(thread => {
    const sameTitle = thread.botTitle.toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedTitle;
    return sameTitle && (!filePath || thread.path === filePath);
  });
  return matches.length === 1 ? matches[0] : null;
}

function hasPriorFinding(threads, finding) {
  if (!finding?.title || !finding?.path) return false;
  const normalizedTitle = finding.title.toLowerCase().replace(/[^a-z0-9]/g, '');
  return threads.some(thread => (
    thread.path === finding.path
    && thread.botTitle.toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedTitle
  ));
}

function threadDisplayTitle(reference, threads) {
  return findMatchingThread(threads, reference)?.botTitle
    || (typeof reference === 'object' ? reference?.title : reference)
    || 'Unknown issue';
}

function hasBotReplyAfterLatestUser(thread, predicate = () => true) {
  const latestUserReplyAt = thread.userReplies
    .map(reply => reply.createdAt || '')
    .sort()
    .at(-1);
  if (!latestUserReplyAt) return false;
  return thread.botReplies.some(reply => (
    (reply.createdAt || '') >= latestUserReplyAt && predicate(reply.body || '')
  ));
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
function buildReviewBody(data, isReReview, modelId, unplaceable, priorThreads = []) {
  const priorityIcon = p => p === 'must_fix' ? '🔴' : '🟡';
  let body = isReReview ? '# 🔍 PR Standards Check (Re-review)\n\n' : '# 🔍 PR Standards Check\n\n';

  if (data.summary) body += `${data.summary}\n\n`;

  if (isReReview) {
    // Persisting issues are bumped as replies on existing threads — just show a count here.
    const persistingCount = data.persisting?.length || 0;
    if (persistingCount > 0) {
      body += `> ⏳ **${persistingCount} issue(s) from the previous review are still open** — see the existing inline comments above.\n\n`;
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
      for (const r of data.resolved) body += `- ${threadDisplayTitle(r, priorThreads)}\n`;
      body += '\n';
    }
    if (data.accepted_explanations?.length) {
      body += `## 💬 Accepted Explanations\n\n`;
      for (const r of data.accepted_explanations) body += `- ${threadDisplayTitle(r, priorThreads)}\n`;
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
 * On re-reviews, persisting issues are bumped as replies on existing threads rather
 * than posted as new inline comments, and resolved/accepted threads are closed.
 */
async function postReview(data, diff, modelId, isReReview, reviewThreads = [], incrementalDiff = null, resolvedThreads = [], reviewedHeadSha = null) {
  const validLines = parseDiffForValidLines(diff);
  // Re-review inline targets must be in both the incremental diff and the current PR diff.
  // Merging the base branch can introduce incremental lines outside the PR's own changes.
  // null incrementalDiff means we couldn't compute it — fall back to full diff to be safe.
  const newFindingValidLines = isReReview
    ? (incrementalDiff !== null ? parseDiffForValidLines(incrementalDiff) : validLines)
    : validLines;

  // Determine which findings need new inline comments
  let findingsForInline = isReReview
    ? (data.new_findings || [])
    : (data.findings || []);

  // On re-reviews, hard-enforce deduplication: drop any new finding that matches an open
  // or resolved thread, regardless of whether Claude respected the prompt instructions.
  if (isReReview) {
    const allPriorThreads = [...reviewThreads, ...resolvedThreads];
    findingsForInline = findingsForInline.filter(finding => {
      if (hasPriorFinding(allPriorThreads, finding)) {
        console.log(`  ℹ️  Dropping duplicate new finding "${finding.title}" — already covered by an existing thread`);
        return false;
      }
      return true;
    });
  }

  const inlineComments = [];
  const unplaceable = [];

  for (const finding of findingsForInline) {
    const fileLines = newFindingValidLines.get(finding.path);
    if (fileLines && fileLines.has(finding.line) && validLines.get(finding.path)?.has(finding.line)) {
      const icon = finding.priority === 'must_fix' ? '🔴' : '🟡';
      inlineComments.push({
        path: finding.path,
        line: finding.line,
        side: 'RIGHT',
        body: `${icon} **${finding.title}**\n\n${finding.body}`,
      });
    } else {
      unplaceable.push(finding);
    }
  }

  console.log(`  ✓ ${inlineComments.length} inline comment(s), ${unplaceable.length} fallback to review body`);

  if (isReReview) {
    const handledThreadIds = new Set();
    const failedResolutions = [];

    // An accepted explanation is one transition: resolve it, then acknowledge only the
    // latest user reply. Failed resolutions stay quiet so a retry cannot stack replies.
    for (const reference of (data.accepted_explanations || [])) {
      const thread = findMatchingThread(reviewThreads, reference);
      if (!thread) {
        failedResolutions.push(typeof reference === 'object' ? reference.thread_id : reference);
        continue;
      }
      if (handledThreadIds.has(thread.threadId)) continue;
      handledThreadIds.add(thread.threadId);
      const resolved = await resolveReviewThread(thread.threadId);
      if (!resolved) {
        failedResolutions.push(thread.threadId);
        continue;
      }
      const alreadyAcknowledged = hasBotReplyAfterLatestUser(
        thread,
        body => body.includes('Explanation accepted')
      );
      if (!alreadyAcknowledged && thread.userReplies.length > 0) {
        await replyToReviewComment(
          thread.firstCommentId,
          '✅ Explanation accepted. This thread has been resolved.'
        );
      }
    }

    // Resolve code-fixed issues once, using the exact thread identity returned to the model.
    for (const reference of (data.resolved || [])) {
      const thread = findMatchingThread(reviewThreads, reference);
      if (!thread) {
        failedResolutions.push(typeof reference === 'object' ? reference.thread_id : reference);
        continue;
      }
      if (handledThreadIds.has(thread.threadId)) continue;
      handledThreadIds.add(thread.threadId);
      if (!await resolveReviewThread(thread.threadId)) failedResolutions.push(thread.threadId);
    }

    // Reply to a persisting issue once per new human response. A historical reply that the
    // bot already answered must not create another bump on every push.
    for (const finding of (data.persisting || [])) {
      const thread = findMatchingThread(reviewThreads, finding, finding.path);
      if (!thread || handledThreadIds.has(thread.threadId)) continue;
      handledThreadIds.add(thread.threadId);
      if (!hasBotReplyAfterLatestUser(thread)) {
        const latestUserReply = thread.userReplies.map(reply => reply.createdAt || '').sort().at(-1);
        if (latestUserReply) {
          const icon = finding.priority === 'must_fix' ? '🔴' : '🟡';
          const bumpBody = finding.bump_message
            ? `${icon} **Still open.** ${finding.bump_message}`
            : `${icon} **Still open.** This issue has not been resolved yet.`;
          await replyToReviewComment(thread.firstCommentId, bumpBody);
        }
      }
    }

    if (failedResolutions.length > 0) {
      throw new Error(`Could not resolve ${failedResolutions.length} review thread(s)`);
    }
  }

  const priorThreads = [...reviewThreads, ...resolvedThreads];
  const reviewBody = buildReviewBody(data, isReReview, modelId, unplaceable, priorThreads);
  const reviewPayload = { body: reviewBody, event: 'COMMENT', comments: inlineComments };
  if (reviewedHeadSha) reviewPayload.commit_id = reviewedHeadSha;

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
    // Fetch complete review state. This read fails closed so missing pages or API errors
    // cannot make an existing PR look like a first review.
    console.log('🔍 Checking for review threads...');
    const {
      open: reviewThreads,
      resolved: resolvedThreads,
      latestReviewCommitSha,
      hasPreviousReview,
    } = await getReviewState();
    if (reviewThreads.length > 0) {
      console.log(`ℹ️  ${reviewThreads.length} open review thread(s) found — will compare and bump/resolve as appropriate`);
    }
    if (resolvedThreads.length > 0) {
      console.log(`ℹ️  ${resolvedThreads.length} resolved thread(s) found — will use as context to avoid re-raising addressed issues`);
    }

    // Get the latest Claude Opus model
    console.log('🔍 Fetching latest Claude Opus model...');
    const modelId = await getLatestClaudeOpusModel();

    // Gather all context
    console.log('📥 Fetching PR details...');
    const prDetails = await getPRDetails();
    const reviewedHeadSha = prDetails.headRefOid;
    if (!isCommitSha(reviewedHeadSha)) throw new Error('GitHub returned an invalid PR head commit');

    // A previous review can exist with no open threads (all resolved) or no inline
    // findings. Its commit is still the correct baseline for new-code detection.
    const isReReview = hasPreviousReview;
    let incrementalDiff = null;
    if (isReReview) {
      console.log('📥 Computing incremental diff since last review...');
      incrementalDiff = await getIncrementalDiff(latestReviewCommitSha, reviewedHeadSha);
    }

    console.log('📥 Fetching PR diff...');
    const diff = await getPRDiff();

    console.log('📄 Fetching changed file contents...');
    const openThreadPaths = [...new Set(reviewThreads.map(thread => thread.path).filter(Boolean))];
    const fileContents = await getChangedFileContents(
      prDetails.files || [],
      openThreadPaths,
      reviewedHeadSha
    );
    console.log(`  ✓ Retrieved ${Object.keys(fileContents).length} file(s)`);

    console.log('🔗 Fetching related files for context...');
    const relatedFiles = await getRelatedFiles(prDetails.files || []);
    console.log(`  ✓ Retrieved ${Object.keys(relatedFiles).length} related file(s)`);

    console.log('📚 Gathering codebase patterns...');
    const patterns = await getCodebasePatterns(prDetails.files || []);
    console.log(`  ✓ Retrieved ${Object.keys(patterns).filter(k => patterns[k]).length} pattern example(s)`);

    // Analyze with Claude
    console.log('\n🤖 Analyzing PR with Claude...');
    const rawAnalysis = await analyzeWithClaude(
      prDetails,
      diff,
      fileContents,
      relatedFiles,
      patterns,
      modelId,
      reviewThreads,
      resolvedThreads,
      incrementalDiff,
      isReReview
    );

    // Parse the structured JSON response
    const analysisData = parseAnalysisJSON(rawAnalysis);
    if (!analysisData) {
      throw new Error('Analysis did not return a parseable JSON response');
    }

    // Do not post an analysis against a different head if another push landed while the
    // model was running. The next workflow run will inspect that new commit instead.
    const currentHeadSha = await getCurrentPRHeadSha();
    if (currentHeadSha !== reviewedHeadSha) {
      throw new Error('PR head changed during analysis; refusing to post a stale review');
    }

    // Post review with inline comments; bump/resolve existing threads on re-review
    console.log('💬 Posting review with inline comments...');
    await postReview(
      analysisData,
      diff,
      modelId,
      isReReview,
      reviewThreads,
      incrementalDiff,
      resolvedThreads,
      reviewedHeadSha
    );

    // Post any general PR-level notes as a plain conversation comment
    if (analysisData.general_notes?.length) {
      console.log('📋 Posting general PR notes...');
      await postGeneralNotes(analysisData.general_notes, modelId);
    }

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
      await removeLabelIfPresent();
      await postSuccessComment(modelId);
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
