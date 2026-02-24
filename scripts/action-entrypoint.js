#!/usr/bin/env node

/**
 * GitHub Action Entrypoint for PR Standards Checker
 *
 * This script is called by GitHub Actions and uses inputs from action.yml
 */

const core = require('@actions/core');
const github = require('@actions/github');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Get action inputs
const GITHUB_TOKEN = core.getInput('github-token', { required: true });
const PR_NUMBER = core.getInput('pr-number', { required: true });
const REPO = core.getInput('repository', { required: true });
const AWS_ACCESS_KEY = core.getInput('bedrock-aws-access-key-id', { required: true });
const AWS_SECRET_KEY = core.getInput('bedrock-aws-secret-access-key', { required: true });
const AWS_REGION = core.getInput('bedrock-region') || 'us-east-1';
const MODEL_ID = core.getInput('model-id') || 'arn:aws:bedrock:us-east-1:257394448189:inference-profile/us.anthropic.claude-opus-4-6-v1';
const STANDARDS_FILE = core.getInput('standards-file') || '';
const IGNORE_CONFIG_FILE = core.getInput('ignore-config-file') || '';
const FAIL_ON_ISSUES = core.getInput('fail-on-issues') === 'true';
const FAILURE_MODE = core.getInput('failure-mode') || 'fail';
const NONCOMPLIANT_LABEL = core.getInput('noncompliant-label') || 'Noncompliant';
const MAX_TOKENS = parseInt(core.getInput('max-tokens') || '16000', 10);

// Set environment variables for the checker script
process.env.GITHUB_TOKEN = GITHUB_TOKEN;
process.env.PR_NUMBER = PR_NUMBER;
process.env.GITHUB_REPOSITORY = REPO;
process.env.BEDROCK_AWS_ACCESS_KEY_ID = AWS_ACCESS_KEY;
process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = AWS_SECRET_KEY;
process.env.BEDROCK_REGION = AWS_REGION;
process.env.MODEL_ID = MODEL_ID;
process.env.MAX_TOKENS = MAX_TOKENS.toString();
process.env.FAILURE_MODE = FAILURE_MODE;
process.env.NONCOMPLIANT_LABEL = NONCOMPLIANT_LABEL;

// Set custom files if provided
if (STANDARDS_FILE) {
  const customStandardsPath = path.join(process.env.GITHUB_WORKSPACE, STANDARDS_FILE);
  if (fs.existsSync(customStandardsPath)) {
    process.env.STANDARDS_FILE = customStandardsPath;
    core.info(`Using custom standards file: ${STANDARDS_FILE}`);
  } else {
    core.warning(`Custom standards file not found: ${STANDARDS_FILE}, using defaults`);
  }
}

if (IGNORE_CONFIG_FILE) {
  const customIgnoreConfigPath = path.join(process.env.GITHUB_WORKSPACE, IGNORE_CONFIG_FILE);
  if (fs.existsSync(customIgnoreConfigPath)) {
    process.env.IGNORE_CONFIG_FILE = customIgnoreConfigPath;
    core.info(`Using custom ignore config: ${IGNORE_CONFIG_FILE}`);
  } else {
    core.warning(`Custom ignore config not found: ${IGNORE_CONFIG_FILE}, using defaults`);
  }
}

async function main() {
  try {
    core.info('Starting PR Standards Check...');
    core.info(`Repository: ${REPO}`);
    core.info(`PR Number: ${PR_NUMBER}`);
    core.info(`Model: ${MODEL_ID}`);

    // Run the checker script
    const checkerScript = path.join(__dirname, 'check-pr-standards.js');

    core.info('Running standards checker...');

    const result = execSync(`node "${checkerScript}"`, {
      encoding: 'utf8',
      stdio: 'pipe',
      env: process.env,
      maxBuffer: 50 * 1024 * 1024,
    });

    core.info(result);

    // Parse output to extract issue counts (if available in output)
    const highMatch = result.match(/HIGH Priority:\s*(\d+)/);
    const mediumMatch = result.match(/MEDIUM Priority:\s*(\d+)/);
    const lowMatch = result.match(/LOW Priority:\s*(\d+)/);
    const totalMatch = result.match(/TOTAL:\s*(\d+)/);

    const highCount = highMatch ? parseInt(highMatch[1], 10) : 0;
    const mediumCount = mediumMatch ? parseInt(mediumMatch[1], 10) : 0;
    const lowCount = lowMatch ? parseInt(lowMatch[1], 10) : 0;
    const totalIssues = totalMatch ? parseInt(totalMatch[1], 10) : 0;

    // Set outputs
    core.setOutput('issues-found', totalIssues.toString());
    core.setOutput('high-priority-count', highCount.toString());
    core.setOutput('medium-priority-count', mediumCount.toString());
    core.setOutput('low-priority-count', lowCount.toString());

    if (totalIssues > 0 && FAIL_ON_ISSUES) {
      core.setFailed(`Standards check found ${totalIssues} issue(s). See PR comment for details.`);
      process.exit(1);
    } else if (totalIssues > 0) {
      core.warning(`Standards check found ${totalIssues} issue(s), but not failing due to configuration.`);
    } else {
      core.info('✅ No standards violations found!');
    }

  } catch (error) {
    core.setFailed(`Standards check failed: ${error.message}`);

    // Try to set outputs even on failure
    core.setOutput('issues-found', '-1');
    core.setOutput('high-priority-count', '0');
    core.setOutput('medium-priority-count', '0');
    core.setOutput('low-priority-count', '0');

    process.exit(1);
  }
}

main();
