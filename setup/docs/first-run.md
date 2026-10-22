# First run after S07/S08

S07 and S08 are intentionally split into **offline verification** and **explicit owner actions**.
`init/apply/resume/verify/status --refresh` must not perform hidden OAuth, hidden live AI calls, or paid fallback.

## Offline verification (S07)

Run plan/apply for S07 after S06:

```bash
factory-setup plan --config ~/.config/agent-factory/setup.json --stage S07
factory-setup apply --config ~/.config/agent-factory/setup.json --plan ~/.local/state/agent-factory-setup/plan.json
```

S07 executes only fake-provider verification and docker no-secret boundary checks.
Expected evidence:

- `~/.local/state/agent-factory-setup/s07-offline-verification.json`
- status `runner_ready_offline`

## Explicit auth and live smoke (S08)

S08 never auto-runs OAuth or live requests during apply/resume.
Owner runs commands explicitly:

```bash
factory-setup auth login --config ~/.config/agent-factory/setup.json
factory-setup auth status --config ~/.config/agent-factory/setup.json
factory-setup smoke --config ~/.config/agent-factory/setup.json --provider live --fixture toy
```

Rules enforced by installer:

- login runs only inside pinned S06 image with `/auth` mount and TTY;
- `auth status` reports only auth presence; it is **not** quota health proof;
- live smoke requires explicit risk/quota gate approvals and S07 verified;
- one bounded attempt (300s), no automatic retry;
- result JSON and terminal events are validated; symlink/special/oversized result is rejected;
- cleanup/schema/unknown usage errors keep S08 blocked, not verified.
