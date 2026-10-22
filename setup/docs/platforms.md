# S13 optional platform-check proposals and readiness

S13 is an **optional** stage for preparing and validating platform-check readiness.  
It does not run GitHub Actions automatically and does not claim cross-platform checks are complete without trusted collector evidence.

## What S13 does

- Validates reviewed request input (`s13-platform-request.json`):
  - exact `candidate_sha` (40-hex),
  - `profile` (`guard` or `browser_smoke`),
  - unique platform enum entries (`linux-x64`, `windows-x64`, `macos-arm64`), max 3.
- Requires owner-reviewed Actions allowance and billing flags before apply.
- Requires a reviewed PR12 adapter record for `browser_smoke` (`s13-browser-smoke-adapter.json`).
- Validates pinned workflow template security constraints:
  - fixed runner labels (`ubuntu-24.04`, `windows-2025`, `macos-15`),
  - pinned action SHAs for checkout/setup-node,
  - `permissions: contents: read`,
  - `persist-credentials: false`,
  - no write permissions and no `${{ secrets.* }}` usage.
- Writes proposal artifacts only:
  - `s13-proposals/factory-platform-check.proposed.yml`,
  - `s13-platform-readiness.json`,
  - `s13-platform-receipt.json`.

## What S13 does not do

- No `workflow_dispatch` execution from installer.
- No retries or POST replay for dispatch.
- No claim that platform checks are passed when collector evidence is missing.

Missing or incomplete evidence is kept as `checks_status=unknown` and `integration_verified=false`.

## Trusted evidence requirements

When `s13-platform-collector-evidence.json` is present, S13 verify checks:

- producer identity (`github-actions:factory-platform-check`),
- trusted workflow path and reviewed workflow SHA,
- exact candidate SHA and actual checkout SHA equality,
- runner identity per platform:
  - linux-x64 → label `ubuntu-24.04`, `RUNNER_OS=Linux`, `RUNNER_ARCH=X64`
  - windows-x64 → label `windows-2025`, `RUNNER_OS=Windows`, `RUNNER_ARCH=X64`
  - macos-arm64 → label `macos-15`, `RUNNER_OS=macOS`, `RUNNER_ARCH=ARM64`

If any required platform check is absent, neutral/skipped, or mismatched, readiness remains unknown/blocked and integration is not marked verified.
