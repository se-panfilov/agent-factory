# VM qualification harness (P15)

This directory contains opt-in helpers for **real** VM qualification required by CONTRACT C11.

`npm test` must not run these checks. They are owner-driven and require explicit confirmation that the host is disposable.

## Guardrails

- Do not run on a developer workstation or production VPS.
- Do not run without explicit owner consent.
- Do not claim PASS from mocks.

## Entry point

```bash
FACTORY_SETUP_OWNER_CONSENT=YES \
FACTORY_SETUP_VM_DISPOSABLE=YES \
setup/tests/vm/run-qualification.sh --host ubuntu@<vm-ip> --ssh-key ~/.ssh/<key>
```

The script only checks consent markers and host reachability, then prints the manual scenario flow that must be executed and documented in `setup/docs/qualification.md`.
