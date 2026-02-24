# Setup Guide

## Initial Setup

### 1. Add Required Secrets

In your repository's **Settings → Secrets and variables → Actions**, add:
- `BEDROCK_AWS_ACCESS_KEY_ID` — your AWS access key
- `BEDROCK_AWS_SECRET_ACCESS_KEY` — your AWS secret key

### 2. Create the Workflow File

Create `.github/workflows/pr-standards.yml`:

```yaml
name: PR Standards

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}
  cancel-in-progress: true

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

### 3. (Optional) Add a Custom Standards File

Create `.github/PR_STANDARDS.md` with your team's rules. If omitted, the action's built-in defaults are used.

### 4. (Optional) Add an Ignore Config

Create `.github/standards-checker-ignore.json`:

```json
{
  "ignorePatterns": [
    "node_modules/**",
    "dist/**",
    "*.generated.ts"
  ],
  "ignoreComment": "standards-checker-ignore"
}
```

---

## Releasing New Versions

```bash
# Tag a new release
git tag -a v1.0.1 -m "Release v1.0.1"
git push origin v1.0.1
```

---

## Local Testing

```bash
export GITHUB_TOKEN="your-github-token"
export PR_NUMBER="123"
export GITHUB_REPOSITORY="owner/repo"
export BEDROCK_AWS_ACCESS_KEY_ID="your-key"
export BEDROCK_AWS_SECRET_ACCESS_KEY="your-secret"

node scripts/check-pr-standards.js
```

---

## Troubleshooting

**Action not found**
- Verify the tag exists: `git ls-remote --tags https://github.com/ss-libs/pr-standards-action.git`
- Ensure the repository is accessible to the calling workflow

**Permission errors**
- Confirm `pull-requests: write` is set in your workflow's `permissions` block

**AWS credential errors**
- Test with the AWS CLI: `aws bedrock list-foundation-models --region us-east-1`
- Verify the IAM user has `bedrock:InvokeModel` permission
