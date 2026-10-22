# S12 optional inference infrastructure

S12 introduces **opt-in** local inference infrastructure for Ollama only.  
By default, cloud-only operation remains unchanged and no hybrid routing is claimed.

## Scope and safety boundaries

- S12 is optional (`optional_features.inference=true`); when disabled, no model staging is attempted.
- The stage requires reviewed pins in `setup_state/s12-inference-pins.json`:
  - immutable Ollama image digest/ref
  - model digest, size, license, `num_ctx=8192`
  - resource admission thresholds (RAM/disk/inodes)
- S12 validates host resource admission before any serving action:
  - default 16 GiB RAM floor for the 10g profile
  - disk/inode floors from reviewed pins
- Serving must remain private:
  - compose template uses internal network
  - no published host ports
  - CPU/memory/PIDs limits are fixed (`cpus=4`, `mem_limit=10g`, `pids_limit=512`)
- S12 verify requires PR8 probe evidence (`s08-live-smoke.json`) as negative egress proof input.

## Routing and capability admission

S12 does **not** enable hybrid routing by itself.  
Routing is considered blocked until reviewed integration evidence exists (`s12-integration-evidence.json`) with all of:

- M3 reviewed
- PR13 infra probe
- PR14 runtime conformance
- PR15 registry
- PR16 router
- PR17 router hardening

Without that evidence, S12 health explicitly records `routing_enabled=false`.

## Disable flow

Use:

```bash
factory-setup inference disable --config PATH
```

Disable is idempotent and follows the required order:

1. block app scheduling through optional app integration hook (if present),
2. stop local serving container,
3. keep model weights/volume intact (no volume delete).

The command updates S12 state evidence and is safe to repeat.
