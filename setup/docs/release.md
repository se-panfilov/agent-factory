# Release packaging and lock policy (P15)

## Scope

P15 release packaging produces deterministic installer artifacts for S00-S14:

- compiled CLI/runtime files (`setup/dist/**`)
- bootstrap script
- schemas/templates
- `versions.lock.json`
- release manifest + archive checksum + detached signature

The host deployment flow must not run `npm install` for installer CLI.

## Required inputs

- reviewed `setup/versions.lock.json` (exact pins, no `latest`)
- reviewed Node release keyring file (`.gpg`)
- owner signing key pair for release archive signature
- source commit (40-hex) for traceability

## Build

```bash
npm --prefix setup run build
npm --prefix setup run release:build -- \
  --out-dir "$PWD/setup-release" \
  --source-commit "<40-hex-commit>" \
  --signing-key "/abs/path/release-signing-private.pem" \
  --verify-key "/abs/path/release-signing-public.pem" \
  --node-keyring "/abs/path/node-release-keys.gpg" \
  --key-id "owner-release-key-2026"
```

Determinism controls:

- stable tar ordering (`--sort=name`)
- normalized owner/group (`0/0`)
- normalized mtime (`@0`)
- manifest file checksums for all packaged files

## Verify

```bash
npm --prefix setup run release:verify -- \
  --archive "$PWD/setup-release/factory-setup-v0.0.1.tar.xz" \
  --checksum "$PWD/setup-release/factory-setup-v0.0.1.tar.xz.sha256" \
  --signature "$PWD/setup-release/factory-setup-v0.0.1.tar.xz.sig" \
  --verify-key "/abs/path/release-signing-public.pem"
```

Verification includes:

- checksum match
- detached signature verification
- archive entry safety (no absolute/traversal paths)

## Admission rules

- Missing or invalid pins in `versions.lock.json` => block release.
- Unexecuted VM evidence => release can be `offline verified`, never `production qualified`.
- Live qualification requires owner-approved real run + M0 evidence.
