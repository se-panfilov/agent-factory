# Quickstart (offline-first, P15)

This quickstart is for the reviewed installer release archive only. It does not auto-provision a VPS, does not run live AI by default, and does not bypass manual gates.

## 1) Build release on trusted owner machine

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

Artifacts produced:

- `setup-release/factory-setup-v0.0.1.tar.xz`
- `setup-release/factory-setup-v0.0.1.tar.xz.sha256`
- `setup-release/factory-setup-v0.0.1.tar.xz.sig`
- `setup-release/factory-setup-v0.0.1/release-manifest.json`

## 2) Verify archive before transport

```bash
npm --prefix setup run release:verify -- \
  --archive "$PWD/setup-release/factory-setup-v0.0.1.tar.xz" \
  --checksum "$PWD/setup-release/factory-setup-v0.0.1.tar.xz.sha256" \
  --signature "$PWD/setup-release/factory-setup-v0.0.1.tar.xz.sig" \
  --verify-key "/abs/path/release-signing-public.pem"
```

## 3) Copy private artifacts to disposable Ubuntu 24.04 amd64 host

```bash
scp -i ~/.ssh/<key> setup-release/factory-setup-v0.0.1.tar.xz* ubuntu@<vm-ip>:~/releases/
scp -i ~/.ssh/<key> setup-release/factory-setup-v0.0.1/node-release-keys.gpg ubuntu@<vm-ip>:~/releases/
```

Never pass credentials in argv. Transport only release artifacts and reviewed key files.

## 4) Bootstrap on host as owner user (not root)

```bash
ssh -i ~/.ssh/<key> ubuntu@<vm-ip>
mkdir -p ~/releases/setup-v0.0.1
tar -xJf ~/releases/factory-setup-v0.0.1.tar.xz -C ~/releases
bash ~/releases/factory-setup-v0.0.1/bootstrap.sh --release-dir ~/releases/factory-setup-v0.0.1
```

## 5) Initialize and run deterministic flow

```bash
~/.local/bin/factory-setup init --profile supervised --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup preflight --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup plan --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup gate list --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup apply --config ~/.config/agent-factory/setup.json --plan ~/.local/state/agent-factory-setup/plan.json
~/.local/bin/factory-setup verify --config ~/.config/agent-factory/setup.json
```

Expected offline milestone: `runner_ready_offline` (no hidden OAuth/live model run).

## 6) Explicit owner-only live actions (optional, separate gate)

```bash
~/.local/bin/factory-setup auth login --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup auth status --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup smoke --config ~/.config/agent-factory/setup.json --provider live --fixture toy
```

Without these explicit actions the install is **offline-qualified only**, not live-qualified.
