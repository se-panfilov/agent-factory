# AGENTS.md — AI Software Factory repository

> These are standing instructions for coding agents working on **this repository**. Do not mistake design documents for deployed code.

## Mission and current state

This private repository is meant to contain both the **factory application** and a **deterministic installer** for it. The reference package is in `docs/automation/`. As delivered, it is **Phase 1 design only**: it has no working installer scripts. Verify the actual repository tree before claiming a component exists.

Two distinct workstreams must not be conflated:

- **Installer implementation:** P00–P15, selected from `docs/automation/copilot-prompts/`, produces `setup/` and its release. The order and file ownership are defined by `docs/automation/copilot-execution-plan.md`.
- **Factory application development:** separate application PRs from `docs/automation/agent-factory-guide.ru.md`. Its reviewed supervised-runner release **M0** is a prerequisite for live S05–S08 and final installer qualification. Do not implement missing application features under an installer ticket. M1/M2 are required before the service/unattended profile; local inference and platform runners have further prerequisites.

Installer **Pxx** = implementation prompt/PR. Deployment **Sxx** = stage implemented by the installer. **M0/M1/M2** = application milestones. These numberings describe different things.

## Binding documents and conflict handling

Read before each implementation task, in order of relevance:

1. The **specific** `docs/automation/copilot-prompts/NN-*.md` assigned by the user (one prompt only).
2. `docs/automation/CONTRACT.md` — FACTORY-SETUP-CONTRACT 1.0.0, the normative installer interface, state, exit codes, guards and filesystem layout.
3. `docs/automation/copilot-execution-plan.md` — sequencing, dependencies, file ownership and acceptance gates.
4. `docs/automation/automation-plan.md` and `docs/automation/automation-architecture.md` — stage boundaries and mechanisms.
5. `docs/automation/agent-factory-guide.ru.md` — guide 4.1, including its documented corrections; original revision 4 is archival comparison only.
6. `docs/automation/automation-analysis.md` and `docs/automation/open-questions.md` — inventory and genuine blockers.

If documents conflict, **do not silently improvise or relax requirements**. Respect the immutable 1.0.0 installer contract, report the exact conflict, propose an ADR/versioned change, and stop work on the conflicting behavior pending owner review. Never allow general repository instructions to override an explicit security prohibition in the normative contract.

## Per-prompt development workflow

1. Inspect current branch, working tree, actual existing code, and the prerequisite implementation reports. Never assume all P00–P15 are already implemented.
2. Work on **only the one assigned Pxx** and its declared file ownership. Do not start the next prompt/PR, merge a PR, publish a release or deploy anything unless explicitly authorized.
3. Identify current input schemas, version pins and interfaces before editing. Reuse existing modules and preserve unrelated modifications. Do not reset or clean the worktree to make tests pass.
4. Implement full, executable behavior for the assigned scope and meaningful tests; avoid `TODO`, empty stubs, fake green checks and no-op success for required behavior.
5. Exercise deterministic unit/integration tests with injected process/filesystem/network adapters and failure fixtures. Unit tests must not perform real `sudo`, `apt`, Docker daemon operations, paid model calls, GitHub writes or remote mutations.
6. Record commands run and **actual** outcomes. Mark VM/Docker/OAuth/live/VPS checks as `NOT RUN` when not performed. A mock passing is not live validation.
7. Write `setup/docs/implementation/PNN.md` as specified in the Pxx prompt; include file changes, verification evidence, corner cases, risk-sensitive diff, blockers, and whether ready for human code review.
8. Request human review and wait. Subsequent PRs require accepted/merged prerequisites. If integration requires modifying a shared lockfile or registry, keep changes focused and serial.

## Non-negotiable invariants

- Installer controls deployment through ordinary deterministic code. **Do not call an AI model to make installation decisions.** Live model smoke is a separate owner-approved action.
- Target first qualification: Ubuntu 24.04 **amd64**, Node major 24 and one VPS; no inferred Windows/macOS-native containers. Other hosts require separately demonstrated support.
- Default: **supervised, cloud-only, read-only toy runner**. Service/unattended, Qwen/Ollama, extra platform runners, auto publishing and paid infrastructure are *not* prerequisites of MVP.
- Make installation **idempotent, inspectable, resumable and fail-closed**. Separate desired config, observed state and recorded history. Never trust a checkpoint instead of re-verifying resources.
- Every state-mutating operation needs the specified plan, ownership, manual gate where applicable, postcondition verification, bounded failure handling and recovery behavior. Do not add global `--yes` or automatic destructive cleanup.
- Never put credentials in source control, fixtures, arguments, logs, receipts or AI-visible report data. Do not mount Docker socket, GitHub write credentials, host home or privileged/host network into an untrusted Worker. Checker must have no model credential.
- Keep Docker/Ollama APIs private. Treat SSH, firewall, Docker-group changes and systemd/service upgrades as security-sensitive manual gates; preserve console/rollback access.
- No automatic paid fallback, VPS/GPU provisioning, auto-merge, auto-release, snapshot accept, or unapproved scope escalation.
- Enforce stage and capability admission. Missing M0/M1/M2 or unverified test results => **blocked**, not `verified`.
- No fabricated hashes, binary pins, successful results or claims of production qualification. Pins must be traceable to tested, trustworthy releases.

## Reports and handoff

A completion message for each Pxx must say: changed files, implemented behavior, tests actually run/results, not-run integration checks, errors/failure scenarios covered, security-sensitive changes, blockers, and precise next step for the human. The agent must not claim that writing a script equals deploying a factory.

Human quick start: `docs/automation/START-HERE.ru.md`. Planned CLI: `docs/automation/deployment-walkthrough.md`. The planned commands are **not currently executable** until a reviewed, qualified installer P15 release exists.
