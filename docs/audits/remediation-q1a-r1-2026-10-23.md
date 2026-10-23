# Q1A-R1 remediation report — 2026-10-23

**Repository:** `se-panfilov/agent-factory`  
**Working branch:** `fix/q1a-r1-recovery`  
**Requested baseline SHA:** `66aea67b6cc32d3c5a91f1a1ebc600663035d779`  
**Actual source SHA before edits (this branch):** `be640e55f0a651c159a19177a1010fd366c5488a`  
**Scope:** only **Q1A-R1 state/recovery safety** (F01/F02/F03 + state-admission part of F06).

## 1) Implemented scope

Changed files:

- `setup/src/core/state.ts`
- `setup/src/core/engine.ts`
- `setup/tests/integration/core-q1a-r1-state-recovery.test.ts` (new)
- `setup/tests/integration/core-q1a.test.ts` (A09 expectation aligned with strict read-only)
- `setup/docs/privileges.md`
- `docs/audits/remediation-q1a-r1-2026-10-23.md` (this report)

Key behavior changes in this pass:

1. **Read-only loader is non-mutating on all damaged paths.**  
   `status` (without refresh), `gate list`, blocked read-only entrypoints, and diagnostic read in `cancel/recover` no longer write/rename/remove state artifacts.

2. **Fresh-install detection is no longer based only on missing `state.json`.**  
   `loadState` now inspects previous generation, quarantine artifacts, and journal evidence; missing primary + evidence is fail-closed (`state_recovery_required`) and does not initialize fresh state.

3. **Corruption protocol is fail-closed and durable-oriented.**  
   For writable paths, recovery marker is persisted before quarantine rename. Marker write failures now return typed `recovery_marker_persist_failed` and do not erase evidence.

4. **Journal uncertainty is explicit and bounded.**  
   Journal parsing is size-bounded (`MAX_JOURNAL_BYTES`), checksum-validated, and marks uncertainty for parse/torn/ordering/unresolved intent at state-load admission points.

5. **Recover is truthful (3 outcomes).**  
   - `recovery_not_required` (state consistent / fresh no-evidence)
   - `recovered_previous_generation` (only supported/provable previous-snapshot case)
   - `exit 8` `recovery_unresolved` when outcome cannot be proven (marker/journal/in-flight remains)

6. **Shared ordinary-effect admission helper is enforced before adapters/effects.**  
   `apply`, `auth login`, `smoke`, `inference disable`, `backup create` block on unresolved in-flight state before adapter/process calls.

7. **`status --refresh` lock ordering fixed.**  
   Writer lock is acquired before any potentially mutating state-load path.

## 2) Failing-before / passing-after evidence (reproducible bugs)

Baseline was reproduced in isolated worktree `/tmp/agent-factory-baseline-66aea67` at exact SHA `66aea67...`.

| Scenario | Baseline result (before) | Current result (after) |
|---|---|---|
| Read-only `status` with held lock + corrupt primary | `exit=8`, **primary renamed**, marker written | `exit=8`, **primary kept**, no marker write |
| Corrupt primary + marker write ENOSPC | first fail, second load fresh (`in_flight=null`, `last_error=null`) | first `recovery_marker_persist_failed`, second `state_corrupt` + marker present |
| No state/previous/marker + journal-only | fresh state initialized | `state_recovery_required`, no state init |
| Marker exists + ordinary `recover` | `exit=0/ok`, marker untouched | `exit=8/blocked`, marker preserved |
| `auth login` with existing in-flight | adapter called (`commandCalls=1`) | blocked before adapter (`commandCalls=0`) |

## 3) Crash/recovery protocol implemented in code

### Load/admission

1. Inspect marker, primary/previous existence, quarantine entries, bounded journal evidence.
2. If marker exists → `recovery_required` (fail-closed).
3. If primary missing and any historical evidence exists (previous/quarantine/journal) → `state_recovery_required`; writable path persists marker.
4. If primary corrupt:
   - read-only path: typed `state_corrupt`, no mutation.
   - writable path: persist marker → quarantine rename+dir fsync → typed `state_corrupt`.
5. Valid state + uncertain journal (oversized/parse/order/unresolved intent) → `journal_recovery_required` (+ marker on writable path).

### Recover

1. Acquire lock (except `--lock-only` path).
2. Decide one of:
   - `recovery_not_required`
   - `recovered_previous_generation` if candidate is trusted and journal has no residual evidence
   - `recovery_unresolved` (`exit 8`) otherwise
3. Trusted candidate checks (before overwrite): schema, installation id, host os/arch, lock hash path binding, non-fallback machine identity, machine-id hash match, no in-flight in candidate.
4. Barrier is cleared only after successful restore commit.

## 4) Fault-injection boundaries actually tested

### R1-03 boundaries (corrupt primary path)

| Boundary ID | Injected boundary | Observed result |
|---|---|---|
| marker-write | `writeText(recovery-required.tmp)` ENOSPC | `exit 8`, uncertainty preserved |
| marker-fsync | `fsyncFile(recovery-required.tmp)` EIO | `exit 8`, uncertainty preserved |
| marker-rename | `rename(recovery-required.tmp→marker)` EIO | `exit 8`, uncertainty preserved |
| marker-dir-fsync | `fsyncDir(state dir)` after marker rename | `exit 8`, uncertainty preserved |
| quarantine-rename | `rename(state.json→state.json.corrupt-*)` EIO | `exit 8`, uncertainty preserved |
| quarantine-dir-fsync | `fsyncDir(state dir)` after quarantine rename | `exit 8`, uncertainty preserved |

### R1-04 boundaries (save current/previous/journal)

| Area | Injected boundaries | Observed result |
|---|---|---|
| Save current | `writeText(tmp)`, `fsyncFile(tmp)`, `rename(tmp→state)`, `fsyncDir(state dir)` | deterministic old/new snapshot or explicit recovery state; no silent fresh reset |
| Save previous | `writeText(prev.tmp)`, `fsyncFile(prev.tmp)`, `rename(prev.tmp→previous)`, `fsyncDir(state dir)` | deterministic old/new snapshot or explicit recovery state |
| Journal append | `appendText(events)`, `fsyncFile(events)`, `fsyncDir(state dir)` | append failure paths exercised; partial journal state becomes explicit uncertainty (`journal_recovery_required`) where applicable |

## 5) R1 acceptance matrix (this pass)

| ID | Result | Evidence |
|---|---|---|
| R1-01 | PASS | `core-q1a-r1-state-recovery.test.ts`: `R1-01 ...` |
| R1-02 | PASS | `...`: `R1-02 ...` |
| R1-03 | PASS | `...`: `R1-03 ...` |
| R1-04 | PASS | `...`: `R1-04 ...` |
| R1-05 | PASS | `...`: `R1-05 ...` |
| R1-06 | PASS | `...`: `R1-06 ...` |
| R1-07 | PASS | `...`: `R1-07 ...` |
| R1-08 | PASS | `...`: `R1-08 ...` |
| R1-09 | PASS | `...`: `R1-09 ...` |
| R1-10 | PASS | `...`: `R1-10 ...` |
| R1-11 | PASS | `...`: `R1-11 ...` (separate Node processes, lock-holder child process) |
| R1-12 | PASS | `...`: `R1-12 ...` |

## 6) A01…A16 and AF mapping (R1 scope only)

### A-matrix delta

| Item | R1 status | Note |
|---|---|---|
| A08 | PASS (R1 scope) | Save/recovery/journal fault boundaries covered |
| A09 | PASS (R1 scope) | Read-only corruption path no longer self-heals by mutation |
| A10 | PASS (R1 scope subset) | Journal-only + unresolved in-flight ordinary-effect blocking |
| A11 | PASS (R1 scope subset) | Reader vs held-writer/recover interleaving covered |
| A12 | PARTIAL | Critical lock-owner scenario covered; full identity matrix remains later |
| A14 | PARTIAL | Admission block for direct auth/smoke/inference/backup ordinary effects done; broader dependency/binding remains R2 |
| Other A01..A07/A13/A15/A16 | Unchanged by this pass | Kept as previously covered/open outside R1 target |

### AF-matrix delta

| AF | R1 delta | Status after R1 |
|---|---|---|
| AF-05 | Read-only non-mutation + durable state/recovery barrier improvements | **PARTIAL**, not fully closed |
| AF-06 | Shared ordinary-effect in-flight admission + truthful recover outcomes | **PARTIAL**, not fully closed |
| AF-03/04/17 | Indirectly improved via admission/recover truthfulness | **PARTIAL/OPEN**, not closed |

Q1A as a whole is **not** declared closed in this report.

## 7) Commands run (Node 24) and outcomes

```bash
PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" node -v
# v24.12.0

PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" npm --prefix setup ci --ignore-scripts --no-audit --no-fund
# exit 0

PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" npm --prefix setup run typecheck --silent
# exit 0

PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" npm --prefix setup run test --silent
# exit 0 (105 passed, 0 failed)
```

Additional reproducibility probes:

- Baseline (separate worktree at `66aea67`) bug probes: executed, defects reproduced.
- Post-fix equivalent probes: executed, expected safe outcomes observed.

## 8) NOT RUN / remaining blockers

- Real sudo/apt/systemd/SSH/firewall, Docker daemon, OAuth/live provider, VM/VPS qualification.
- Full external reconciler for apt/docker/provider effects: unresolved cases intentionally remain `exit 8`.
- Per-operation execution/journal/cancel granularity inside stage internals remains broader R2/R3 scope.

## 9) Next package boundary

Next step is **Q1A-R2 only** (fresh admission/binding, truthful outcomes across remaining entrypoints, dependency graph/binding closure).  
This R1 report does not claim Q1B/Q2/Q4/Q5 readiness.
