# Q1A-R1.2 remediation report — 2026-10-23

**Repository:** `se-panfilov/agent-factory`  
**Baseline:** `b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4`  
**Tested code identity:** `HEAD=b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4` + working-tree patch hash `f0557cabdb146bf9707e2e3924bad3930b0b662635a58846dd37a9c4735778cd` (см. `audit/evidence/q1a-r1-2-b0bc219/identity.txt`)  
**Evidence package:** `agent-factory-q1a-r1-2-evidence-b0bc219.zip`  
**Evidence package SHA256 (separate file):** `e7bd287a1b29d17e12f3840ab8ffe802a43dbd0c45c8918aa81f64e37218d097` (`agent-factory-q1a-r1-2-evidence-b0bc219.zip.sha256`)  

> Этот отчёт **не** объявляет AF-05/AF-06/Q1A полностью закрытыми и **не** стартует R2/Q1B автоматически.

## 1) Что изменено в R1.2

Изменения сделаны в согласованном пакете state/engine/producers/tests/docs:

- `setup/src/core/state.ts`
  - введён внутренний `state-commit.json` (generation + `last_state_hash` + `last_effect_checkpoint`);
  - `saveState` обновляет commit-manifest на каждом законном state write;
  - `appendEvent` возвращает metadata записи (sequence/attempt/op/stage/state_hash);
  - `loadState` валидирует связку `state.json` ↔ `state-commit.json` ↔ latest checkpoint журнала;
  - `restorePrimaryState` сохраняет не только primary state, но и корректный generation manifest; ошибки persistence дают typed exit 8 (`recovery_primary_persist_failed`).
- `setup/src/core/engine.ts`
  - строгая валидация receipts по planned operation/stage/resource (reject missing/duplicate/foreign/unplanned);
  - per-operation intent/effect/verify/checkpoint вместо агрегированного stage-receipt;
  - no-op/verify-only execution path не вызывает mutating `stage.apply`;
  - после checkpoint пишется commit proof (`recordEffectCheckpoint`);
  - recovery: immutable prepared decision, проверка candidate/current неизменности, отказ от blanket fallback, journal safety admission без автоматического снятия unknown.
- `setup/src/stages/system.ts`
  - S02 выдаёт receipts per operation (`apt-update`, `simulate`, `install`);
  - `operations.length === 0` возвращает пустой receipts-массив (apply no-op обрабатывается движком как read-only).
- `setup/src/stages/configuration.ts`
  - S06 no-op (`operations.length === 0`) → verify-only path;
  - выровнен `resourceId` receipt (`configuration-and-pinned-image`) с planned operation.
- Тесты:
  - обновлены существующие R1/J сценарии;
  - добавлены K-сценарии для R1.2 (`K01`, `K04`, `K05`, `K07`, `K08`, `K09`, `K10`) и усилена fault-matrix.

## 2) Commit/recovery protocol (кратко)

Полная таблица границ и crash semantics:  
`audit/evidence/q1a-r1-2-b0bc219/protocol-commit-boundaries.md`

Ключевые инварианты:

- `state_hash` участвует в admission через `state-commit.json`, а не как декоративное поле.
- checkpoint принимается только при полном identity match (`attempt_id`, `operation_id`, `stage`, `sequence`, `state_hash`) между journal и manifest.
- prepared recovery decision неизменяема между resume-попытками.
- readers (status/gate-list/read-only diagnostics) не чинят и не переписывают evidence.

## 3) R11-F01…R11-F06 status

| Finding | Status | Проверка |
|---|---|---|
| R11-F01 | PASS | `K01 stale primary plus completed journal checkpoint remains recovery-blocked` |
| R11-F02 | PASS | `K07 ... receipts must match ...`; S02/S06 producer alignment tests |
| R11-F03 | PASS | `K09 empty or verify-only plan does not call stage.apply`; `K08 ... S06 ... no-op` |
| R11-F04 | PASS | `K04 prepared recovery decision is immutable ...`; `J06` |
| R11-F05 | PASS | `K05 missing primary ... remains unresolved without generation proof` |
| R11-F06 | PASS | `J06`/`J07` (typed recovery persistence/cleanup outcomes) |

Machine-readable mapping: `audit/evidence/q1a-r1-2-b0bc219/probe-results.json`.

## 4) K01…K12 status

| ID | Status | Evidence |
|---|---|---|
| K01 | PASS | `K01 ... stale primary ... blocked` |
| K02 | PASS | `J01`, `J02`, `A05` |
| K03 | PASS | `R1-04`, `J06` |
| K04 | PASS | `K04 ... immutable decision` |
| K05 | PASS | `K05 ... missing primary unresolved` |
| K06 | PASS | `J06`, `J07`, `J09` |
| K07 | PASS | `K07 ... receipt matching` |
| K08 | PASS | `J01`, `J02`, `K08` (real S06 fresh no-op lifecycle) |
| K09 | PASS | `K09 ... trap stage applyCalls=0` |
| K10 | PASS | `K10 cross-process interrupted writer ...` |
| K11 | PASS | `J03`, `J08`, `J10`, `R1-12` |
| K12 | PARTIAL | Полный suite прошёл; но run выполнен в `node v26.5.1`, а не в Node 24 (см. §6) |

## 5) Before/after (same fixtures) и baseline reproduction commands

Внешний probe (вне checkout):  
`/Users/splswrd/.copilot/session-state/d25c4f28-cda2-494b-8e2c-932f0f5d2ac0/files/q1a-r11-evidence/audit/evidence/q1a-r1-1-4d536cc/probe-r11-matrix.cjs`

Команды воспроизведения:

```bash
# baseline (clean detached worktree at b0bc219)
git -C /Users/splswrd/work/agent-factory worktree add --detach /tmp/af-b0 b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4
npm --prefix /tmp/af-b0/setup ci --ignore-scripts --no-audit --no-fund
npm --prefix /tmp/af-b0/setup run build --silent
cd /tmp/af-b0 && node /Users/splswrd/.copilot/session-state/d25c4f28-cda2-494b-8e2c-932f0f5d2ac0/files/q1a-r11-evidence/audit/evidence/q1a-r1-1-4d536cc/probe-r11-matrix.cjs baseline

# remediated working tree
cd /Users/splswrd/work/agent-factory
npm --prefix setup run build --silent
node /Users/splswrd/.copilot/session-state/d25c4f28-cda2-494b-8e2c-932f0f5d2ac0/files/q1a-r11-evidence/audit/evidence/q1a-r1-1-4d536cc/probe-r11-matrix.cjs fixed
```

Сохранённые результаты:

- `audit/evidence/q1a-r1-2-b0bc219/results-baseline-b0bc219-probe.json`
- `audit/evidence/q1a-r1-2-b0bc219/results-fixed-working-tree-probe.json`

Отдельно для N07:

- baseline probe и fixed probe показывают, что path с missing-primary/legacy uncertainty остаётся blocked (не объявляется safe);
- safe proven recovery проверяется отдельными R1.2 тестами `R1-08`, `J06`, `J07`, `J09`.

## 6) Обязательные команды и фактические результаты

Лог: `audit/evidence/q1a-r1-2-b0bc219/node-npm-and-required-commands.log`

Выполнено:

```bash
node --version                              # v26.5.1
npm --version                               # 11.17.0
npm --prefix setup ci --ignore-scripts --no-audit --no-fund   # 0
npm --prefix setup run typecheck --silent                     # 0
npm --prefix setup run test --silent                          # 0 (123 passed, 0 failed)
```

Ограничение текущей среды: Node 24 binary отсутствует, поэтому Node 24 qualification в этой сессии помечена как `PARTIAL`/`NOT RUN`.

## 7) Stage producers inventory (R1.2-sensitive)

| Stage | Producer status | R1.2 notes |
|---|---|---|
| S00/S01 | compatible | используется в lifecycle/K10 regressions |
| S02 | updated | per-operation receipts + no-op receipts removed |
| S06 | updated | no-op verify-only path; receipt resource alignment |
| S12+ | inventory-only | не изменялись в этом пакете; effect admission сохраняется движком |

## 8) Security-sensitive / blocked surfaces

- Реальные host/live/VM проверки (sudo/apt/systemd/SSH/firewall/Docker daemon/OAuth/provider/model/GitHub writes/provisioning) — **NOT RUN**.
- Внешний process supervisor и полный per-effect cancel orchestration остаются последующими пакетами.
- Unknown external effect не auto-replay/auto-clear: остаётся `exit 8` до доказуемой reconciliation.

## 9) Code/test/qualification status

- **Code status:** PASS (R11-F01…F06 реализованы, контейнмент сохранён).
- **Test status:** PASS (целевой recovery suite + full `npm --prefix setup run test --silent` зелёный).
- **Qualification status:** PARTIAL (Node 24 environment недоступен в этой сессии; live/VM checks NOT RUN).
