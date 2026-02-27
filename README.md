# PR Standards Action

Automated PR code review using Claude AI to enforce your team's coding standards. Posts findings as inline comments directly on the relevant lines of the diff.

## Features

- 🤖 **AI-Powered Review**: Uses Claude via AWS Bedrock to analyze code changes
- 📍 **Inline Comments**: Posts findings directly on the relevant diff lines
- 🔁 **Thread-Aware Re-reviews**: On follow-up pushes, persisting issues are bumped as replies on their existing threads — no duplicate comments
- 💬 **User Reply Evaluation**: Claude reads developer responses to open review comments and resolves threads where the explanation is valid
- 📋 **Customizable Standards**: Bring your own standards file or use the built-in defaults
- 🏷️ **Flexible Failure Mode**: Fail the build or apply a label — your choice
- 🚫 **Ignore Support**: Exclude files, folders, or specific code sections from review
- 📝 **PR-Level Notes**: Title and description issues are posted as conversation comments, not random inline annotations
- ✅ **Pass Confirmation**: Posts a success comment when the PR clears all checks
- 🔒 **Secure**: Runs with your own AWS Bedrock credentials

## Quick Start

Add this workflow to `.github/workflows/pr-standards.yml`:

```yaml
name: PR Standards

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  pr-standards:
    if: ${{ !github.event.pull_request.draft && !github.event.pull_request.merged }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Check PR standards
        uses: ss-libs/pr-standards-action@v1.0.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          pr-number: ${{ github.event.pull_request.number }}
          repository: ${{ github.repository }}
          bedrock-aws-access-key-id: ${{ secrets.BEDROCK_AWS_ACCESS_KEY_ID }}
          bedrock-aws-secret-access-key: ${{ secrets.BEDROCK_AWS_SECRET_ACCESS_KEY }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | Yes | — | GitHub token for posting comments and reviews |
| `pr-number` | Yes | — | Pull request number |
| `repository` | Yes | — | Repository name (`owner/repo`) |
| `bedrock-aws-access-key-id` | Yes | — | AWS access key ID for Bedrock |
| `bedrock-aws-secret-access-key` | Yes | — | AWS secret access key for Bedrock |
| `bedrock-region` | No | `us-east-1` | AWS region |
| `model-id` | No | Claude Opus ARN | Claude model ID or inference profile ARN |
| `standards-file` | No | built-in defaults | Path to your standards file (relative to repo root) |
| `ignore-config-file` | No | built-in defaults | Path to your ignore config (relative to repo root) |
| `failure-mode` | No | `fail` | `fail` to fail the pipeline, `label` to apply a PR label instead |
| `noncompliant-label` | No | `Noncompliant` | Label name used when `failure-mode` is `label` |
| `fail-on-issues` | No | `true` | Legacy: whether to fail when issues are found (prefer `failure-mode`) |
| `max-tokens` | No | `16000` | Maximum tokens for the Claude response |

## Outputs

| Output | Description |
|--------|-------------|
| `issues-found` | Total number of issues found |
| `high-priority-count` | Number of Must Fix issues |
| `medium-priority-count` | Number of Other issues |
| `low-priority-count` | Always `0` (reserved) |

## Customization

### Custom Standards File

Create `.github/PR_STANDARDS.md` in your repository:

```markdown
# My Team Standards

## Security
- Never hardcode credentials
- Always validate user input
- Use parameterized queries

## Code Quality
- Use TypeScript for all new code
- No `any` types
- All functions must have return type annotations
```

Then reference it:

```yaml
with:
  standards-file: '.github/PR_STANDARDS.md'
```

### Ignore Configuration

Create `.github/standards-checker-ignore.json`:

```json
{
  "ignorePatterns": [
    "node_modules/**",
    "dist/**",
    "*.test.js",
    "migrations/**"
  ],
  "ignoreComment": "standards-checker-ignore"
}
```

#### Ignore Specific Code Sections

```typescript
// standards-checker-ignore-start
const legacyCode = doSomethingOld();
// standards-checker-ignore-end

const temp = hackyFix(); // standards-checker-ignore
```

### Label Mode

To keep the pipeline green but flag non-compliant PRs:

```yaml
with:
  failure-mode: label
  noncompliant-label: 'Needs Review'
```

The label is created automatically if it doesn't exist. It is removed when the PR subsequently passes.

## AWS Bedrock Setup

### Required IAM Permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel"],
      "Resource": "arn:aws:bedrock:*::foundation-model/anthropic.claude-*"
    }
  ]
}
```

### GitHub Secrets

Add to your repository settings:
- `BEDROCK_AWS_ACCESS_KEY_ID`
- `BEDROCK_AWS_SECRET_ACCESS_KEY`

## How Re-reviews Work

Each time the action runs on a PR that already has open bot review threads:

1. **Persisting issues** — a reply is posted on the existing thread to bump it. No duplicate inline comment is created.
2. **Fixed issues** — the thread is automatically resolved.
3. **User-explained issues** — if you reply to a bot comment explaining why the pattern is intentional, Claude evaluates the explanation against your standards. If it's valid, the thread is resolved with an acknowledgement; if not, it's bumped with a note on why the explanation was insufficient.
4. **New issues** — posted as fresh inline comments as usual.
5. **PR-level notes** — concerns about the title, description, or missing context appear as a plain conversation comment rather than as inline annotations on code files.

### Required Permissions

Thread resolution uses the GitHub GraphQL API, which requires the workflow's `GITHUB_TOKEN` to have `pull-requests: write`. This is already needed to post comments, so no additional setup is required.

## Troubleshooting

**"The provided model identifier is invalid"**
- Verify Claude Opus is enabled in your AWS region
- Check that the `model-id` or inference profile ARN is correct

**"Permission denied" errors**
- Ensure the workflow has `pull-requests: write` permission
- Check repository settings → Actions → Workflow permissions

**AWS credential errors**
- Verify the secrets are configured in repository settings
- Check the IAM user has `bedrock:InvokeModel` permission

## License

MIT
