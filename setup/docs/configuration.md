# S06 configuration and pinned image

S06 materializes deterministic Level1 configuration and pinned runner image inputs after S05.  
The stage stays fail-closed: unknown policy fields, malformed JSON, unsafe paths, codex CLI probe failures, pin drift, or cross-host image metadata all block apply with explicit remediation.

## What S06 manages

- `paths.application_auth_dir` and `paths.application_state_dir` as **0700** private directories.
- `paths.application_dir/policy-level1.json` as canonical Level1 policy (**0600**) for supervised cloud-only daily3 timeout300 with a single `scout` role.
- User edits are never overwritten: if policy differs, S06 writes:
  - `policy-level1.json.proposed`
  - `policy-level1.json.proposed.diff`
  and stops with manual gate instruction.
- Toy fixture repository in `paths.application_work_dir/factory-toy-fixture` with deterministic content/identity marker.
- Build context under `paths.setup_cache_dir/s06-agent-image-context/<context-hash>` with secrets excluded via `.dockerignore`.
- Image metadata in `paths.setup_state_dir/s06-agent-image.json` with local machine binding; image IDs from another machine are invalidated and rebuilt.

## Pinning and checks

S06 reads `version_lock_path` and validates it with `installer-release.schema.json`.  
It requires and verifies:

- `codex.version` + `codex.integrity`
- `images.base_image_platform_digest`
- `images.agent_image_digest`
- Codex CLI capability probes (no auth required): `codex --version`, `codex exec --help`, `codex login --help`
- Immutable build-context hash for generated Docker build inputs

## Security boundaries

- No secrets are written into templates, state JSON, or git fixture contents.
- Symlink targets for private dirs/policy are rejected.
- Path values containing newline/comma are rejected (`fail closed`).
- Stage does not trust image metadata from other machines.
