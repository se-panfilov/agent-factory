# Q1A-R2.1 — trusted producer policy и срок плана

2026-10-25, Europe/Amsterdam. **R2.1 local scope PASS; production OPEN; real-host qualification NOT RUN.** R2-F01/F02 закрыты в локальном scope. R1.6 принятие сохранено; R15-F01 не переоткрывается. R2.2, R3/Q1B/Q2–Q6 и общий AF backlog остаются OPEN. Коммитов, push, веток/worktree/PR, merge/tag/release/deploy агентом не выполнялось; git index для packaging не использовался.

## Actual base и owner layer

Initial HEAD `ca6d0b6f2a75f3c97a80468bbc2bdcbe2db7a4ff`, tree `9a0f861b71ebce4df8c56850dcf6c6764e1082a4`, branch `master`. `git status --porcelain=v1` пустой; initial staged/unstaged/new-file owner layer пуст. Index SHA-256 до/после: `b95af8c89f59acfaca7c8094796c088e9021f8fde3059b2da5b71d75c4404957`. Read-only snapshot и пустые initial patches сохранены; чужие файлы/dependencies не удалялись.

Delta к проверенному `5fde93d2c470171039698c35478c020085ef66ff` — только четыре committed audit-входа: `audit/copilot-q1a-r2-1-task.ru.md`, `audit/evidence/agent-factory-r16-review-evidence-5fde93d.zip`, его `.sha256`, `audit/reviews/agent-factory-r16-audit-5fde93d.ru.md`. Имена/hashes — `base-delta.json`. Все 138 файлов R1.6 manifest SHA-256 `a95c623dde5996cf6abf4f93d9b03e76fdaef9fe0fc5ca6b6ced11fe0a9de5cb` совпали с actual base archive. Production baseline применим без изменений.

Прочитаны AGENTS.md, аудит R1.6, report R1.6, CONTRACT C06/C08/C09/C13, релевантные core/stage tests. Это явно назначенный cross-cutting remediation. Public CLI/config/state/plan schemas, exit enum и CONTRACT 1.0.0 не изменены. C13 serialization/context binding этим пакетом не объявляются выполненными.

## Before → after

Исходный `r2-admission-probes.cjs` заморожен без изменения oracle. Одинаковый runner запущен на actual base и reconstructed fixed; API adapter не понадобился. Настоящие engine и S02 producer, APT — fake counters; TTL producer явно synthetic. `harness_ok`/exit0 не засчитывались за product PASS.

| Probe | Baseline | Fixed |
|---|---|---|
| R2A01 valid approved | exit0, refresh/simulate/install=1/1/1 | Сохранён exit0, 1/1/1 |
| R2A02 no approvals | exit4, 0/0/0 | Сохранён отказ, 0/0/0 |
| R2A03 strip both gate arrays + recompute hash | **exit0, S02 verified, 1/1/1 — unsafe** | **exit2 plan_policy_mismatch, 0/0/0, не verified** |
| R2A04 one-sided gates | exit2, 0/0/0 | Сохранён semantic refusal |
| R2A05 wrong hash | exit2, 0/0/0 | Сохранён отказ |
| R2A06 gate-free age5min | exit0, effects=1 | Сохранён exit0/effects=1 |
| R2A07 gate-free age31min | **exit0/effects=1 — unsafe** | **exit4 plan_expired/effects=0** |
| R2A08 creation1h in future | **exit0/effects=1 — unsafe** | **exit8 plan_from_future/effects=0** |

Итог: baseline **5 safe / 3 unsafe**, fixed **8 safe / 0 unsafe**. Raw rows — `logs/baseline-r2-final.log`, `logs/fixed-r2-final.log`; отдельные product assertions — `r2-product-assertions.json`.

До production edits записан regression layer: strip gates и два gate-free age cases падают на baseline по правильным assertions; старый gate-expiry control проходит. Build exit0; **4 tests: 1 pass / 3 fail**, exit1. Frozen red-layer и повтор с elapsed/exit сохранены. Другие tampering variants — coverage класса дефекта, не заявление, что каждый уже был baseline exploit.

## Design note: policy, progress и persistence

Подробный protocol — `setup/docs/plan-admission-r21.md`.

Submitted plan остаётся предложением. Единственный источник operation/gate definitions — trusted `stage.plan(config, observation)` плюс registry profile/optional/capabilities. Core сравнивает полную canonical stage policy: parent/stage/id/order/kind/resource/risk/preconditions/side effects/timeout/retry, operation gates и stage-only gates. IDs также уникальны глобально. Нельзя убрать simulation/gate либо переименовать effect, сохранив adapter behavior. Required external prerequisite не становится одобряемым gate. Submitted plan не переписывается и approvals не добавляются.

Для restart и собственных transitions нужен исходный reviewed producer input: S03/S04 operation IDs и preconditions зависят от observation hashes. Только fresh planning теряет исходную последовательность, а process-local cache не переживает restart. Поэтому core сохраняет **валидируемую internal PolicyBasis** в существующем `stage.versions.setup_policy_basis_v1`: source observation, plan/config binding, expected significant-input fingerprint и completed IDs. Это существующий extensible string map, без нового public field/schema version и без sidecar. Parser проверяет точные поля/типы/hash/stage/finite values/completion IDs, лимит 64 KiB/stage. Исходный JSON key order сохраняется для совместимости существующих S03/S04 hash producers.

Это не просто «доверенный любой клиентский hash»: canonical policy заново получается из trusted producer и captured observation; текущие inputs проверяются под lock. Отдельный legacy test без enrollment доказывает отказ stripped gates/пропущенной simulation/изменённого timeout даже без stored plan hash. Plan/config hash служит дополнительным binding, не заменой semantic policy.

Progress/expected inputs публикуются в том же snapshot/hash, который связывается существующим operation checkpoint и manifest. Intent/effect/verify/checkpoint/final clean proof protocol не переписан. Частичная запись по-прежнему разрешается только существующим evidence evaluator; policy metadata не обходит generation/quarantine/journal checks. Если publication не доказана, результат остаётся unresolved, не false success. State observation helper только сохраняет core-owned key и не принимает его подмену от stage versions.

Current producer requirements сверяются перед следующим action: собственный verified effect не разрешает новый gate/resource/risk/constraint автоматически. В таком случае предыдущий checkpoint остаётся известным, следующий intent отсутствует, требуется явный re-plan/review. Новые stage-only requirements после последнего effect также блокируют final verified, сохраняя завершённый checkpoint. Resource-level verified не удаляет обязательные ещё не выполненные orchestration steps (S03 arm/cutover/tailnet/disarm, S05 probes).

Для observation-derived полей S03/S04 имеются узкие typed reconciliation callbacks. Они могут вернуть только id/preconditions; gates/kind/resource/risk/limits остаются от fresh producer и сравниваются core. Нормализуются observation hash и только подтверждённые own-transition flags: S03 public-exposure после bound cutover; S04 installed/managed/config hash после соответствующих receipts. Pins/manual prerequisites/fixture и новые requirements не нормализуются. Raw significant inputs и stage-specific admission по-прежнему должны совпасть с подтверждёнными postconditions. S02 добавляет read-only pre-intent проверку candidate pins/privilege/dpkg readiness.

S05 policy observation специально не исполняет application commands перед materialization checkpoint. Она проверяет archive/checkout/current content; обычные observe/verify/probe по-прежнему выполняют обязательные R1.6 prepared commands. S04 fingerprint исключает только core-derived completed-resource list; security/resource facts сохранены. Общая policy projection не сравнивает observed_at и producer-ignored volatile counters буквально.

Legacy без basis и без known progress получает строгую fresh producer validation. При known legacy progress требуется явный current review; matching config-bound receipt и current postcondition verification позволяют перенести известное завершение, а не повторять его. Unsupported/malformed/future basis блокируется до записи плана, не удаляется и не мигрируется в authorization. Новый review может согласованно reconcile ресурс, у которого старый postcondition больше не выполняется; **unknown journal outcome** всё равно блокирует до recovery. Legacy без необходимого verifier не объявляется complete.

`resume` теперь использует **существующий** reviewed plan и не вызывает implicit plan generation/TTL renewal. Новый Docker login требует явного remaining plan/review/gates. При новом plan старые approvals не переносятся на иной hash. Exact unchanged known operations переносятся только с receipt/current verifier; partial progress работает между новыми engine instances и отдельными subprocesses.

## Lock, time и ошибки

Config/plan bounded snapshots — по 1 MiB, unambiguous UTF-8 JSON — сверяются после lock; parsed identity перепроверяется. Перед каждым action повторяются bytes/time/policy/admission/approvals checks. Changed request не исполняется из старой памяти и не подменяется новым файлом молча. Это проверка назначенных lock barriers, не полный filesystem/session concurrency proof.

Один injected clock определяет plan/gate expiry. Runtime `created_at` — строгая planner ISO/UTC millisecond форма `YYYY-MM-DDTHH:mm:ss.sssZ`, finite round-trip, без невозможных дат. Future creation блокируется без skew allowance; `now >= created_at + 30min` истёк, в том числе без gates. Уже admitted bounded APT action не убивается по TTL: сначала его postconditions/checkpoint, затем блокируется следующий action. Gate expiry независим и не продлевается. Gate-approve может сохранить expired status, сохраняя исходный expires_at и receipts.

| Причина | Typed exit |
|---|---|
| JSON/schema/self-hash/producer-policy mismatch, invalid timestamp/operation identity/unreviewed plan identity | 2 |
| Significant/current-policy/pin drift, future timestamp, changed/unreadable request, invalid/unsupported policy basis, legacy progress needing review | 8 |
| Plan expired, approval missing/expired, прежние stage-specific manual prerequisites | 4 |
| Прежние security/integrity refusals | 9 |
| Unsupported profile/capability/entrypoint, не одобряемый external prerequisite | Прежние guards 5 |

Refusal перед новым effect не пишет target intent, не очищает history/receipts и не превращает уже known progress в unknown. Admission error возвращается без last_error/state rewrite; при TTL pause частичный stage может оставаться applying с `in_flight_operation=null` и доказанным checkpoint, а не verified. Действительно неизвестный effect сохраняет существующий in-flight blocker.

## Production diff

- `core/plan.ts`: runtime TTL, strict date/JSON semantics, shared stage serialization, internal observation result для enrollment.
- `core/policy.ts` (новый): typed/bounded basis validation, producer comparison, current-policy continuation; без duplicated gate policy lists.
- `core/engine.ts`: enrollment/current policy, post-lock/request checks, per-action TTL/approvals, known-progress reuse, no implicit resume re-plan, expired-plan approval refusal.
- `core/types.ts`: только internal optional policy interfaces.
- `core/state.ts`: только preservation/reservation core metadata в observation update; generation/journal/recovery algorithms не менялись.
- `stages/system.ts`: pre-intent APT readiness/pin check.
- `stages/access.ts`, `docker.ts`: узкая нормализация observation-derived fields по proven progress. Docker также различает package/account drift и relogin до session check.
- `stages/application.ts`: non-executable policy observation, чтобы core не запускал probes до durable trust.

Изменения дополнительных stage/state файлов необходимы для одинаковой identity модели и безопасных own transitions; нельзя было решить это вторым gate-name allowlist либо буквальным сравнением original/current observations. Public schemas/CLI/exit enum, ProcessAdapter и `adapters/git.ts` R1.6 не менялись.

## Acceptance matrix

Полные имена assertions, source и logs — `acceptance-matrix.json`; final raw log — `logs/final-validation/tests.log`. Parameterized inner cases перечислены явно в test source и machine rows.

| ID | Проверяемые assertions | Local status |
|---|---|---|
| A21-01 | Actual S02 strip обоих arrays + rehash; 0 APT calls, refusal до target intent; independent legacy/no-basis test; R2A03 | PASS |
| A21-02 | Wrong/nonempty/missing/shared gate variants; state/previous/manifest/journal/marker hashes unchanged; original approvals остаются пригодны только original policy; newly required gate после own progress блокирует следующий effect | PASS |
| A21-03 | Parent/stage/id/kind/resource/risk/preconditions/side effects/timeout/retry/duplicate/order/no simulation; rehash; global duplicate IDs между stages; 0 target effects; current changed resource/risk requires review | PASS |
| A21-04 | Stage-only gate ops=[], external-required unapprovable, optional/capability forgery; correct no-op без apply; internal metadata corruption/legacy positive controls | PASS |
| A21-05 | Actual S02 reviewed/approved plan, новые instances; refresh/simulate/install=1/1/1 и verified | PASS |
| A21-06 | No approvals/bad hash/one-sided gate control, typed invalid JSON/unreadable input, zero effects | PASS |
| A21-07 | Explicit S02 с prerequisite closure при config.selected_stages=[S06]; generic S08/S14 blocked. Frozen real S00…S07 composition сохранилась | PASS local |
| A21-08 | Separate owned plan/tamper/approve/apply/resume processes с actual S02, persistent fake APT facts и no replay; legacy simulation proof сохранён; старые S03/S04/S05/crash controls проходят | PASS local |
| A21-09 | Gate-free 0/30min−1ms/30min/+1ms/31min/future−1ms/−1h; malformed/non-UTC/no milliseconds/impossible dates; negatives без effects/evidence mutation | PASS |
| A21-10 | После первого verified checkpoint время пересекает TTL; second=0, null in-flight; old resume blocked/bytes retained; explicit review продолжает без replay | PASS |
| A21-11 | Controlled mkdir-lock barriers config/plan, hit count1; request_changed_after_read=8, target counters0, evidence hashes unchanged | PASS |
| A21-12 | Actual S02 same-planned candidate drift и refresh revealing new pins; no unreviewed install. Synthetic volatile/timestamp control проходит; new gate/resource/risk после собственного effect требует review | PASS |
| A21-13 | Expired approve/resume не обновляют expiry/identity; actual completed S02 refresh checkpoint/binding/journal сохранены; новый review доводит sim/install без refresh replay; старые gate TTL/upsert tests | PASS |
| A21-14 | **429/429**, все прежние 397 сохранены без удаления/переименования; old fault/crash rows; 33 frozen и 37 command assertions, composition; reconstruction до/после совпадает | PASS local |

F01/F02 — PASS local по этой матрице, не по одному harness exit. Ошибочные intermediate runs сохранены: первичный metadata JSON key sorting вызвал honest producer mismatch; один test использовал TS-private registry и исправлен на явный public registry fixture; ранняя continuation проверка ошибочно считала resource-level verified завершением orchestration и исправлена. Build/type errors и fixture issues не считаются baseline product failure. Исторические R11/R12/R13/K/T/U/V/W смыслы не переименованы.

## Фактическая validation и упаковка

Реальный Node **v24.12.0**, npm **11.6.2**, macOS **15.5 arm64**, UID **501**. `process.versions` не подменялся; actual host не является Ubuntu VPS qualification. Owner dependencies оставлены; npm ci выполнен только в собственной ordinary temporary copy.

| Final reconstructed command | Exit / result |
|---|---|
| `node --version` | 0, v24.12.0 |
| `npm --version` | 0, 11.6.2 |
| `npm --prefix setup ci --ignore-scripts --no-audit --no-fund` | 0 |
| `npm --prefix setup run typecheck --silent` | 0 |
| `npm --prefix setup run test --silent` | 0, **429 pass / 0 fail / 0 skip** |

Exact argv/cwd/exit/elapsed — `final-validation/commands.json`, `comparison-commands.json`, `frozen-comparisons/independent-commands.json`. Frozen **33 assertions PASS**. Original R1.6 checker — **37 PASS**, включая агрегат этих 33, не 70 unique scenarios. Для его исторического baseline отдельно собран `b888082` (R1.5); это replay известного старого baseline, не новый контрпример R1.6. R2 baseline везде actual `ca6d0b6`.

Нового tested commit **нет**. Identity: actual base + complete local patch; tested-files manifest — **143 файла**, SHA-256 `75973014385506fd0228e64c4d0165effdb38b267c3c94f2aa3c20ae4685ae8c`. Проверены SHA каждого current/reconstructed input до/после final suite. Coverage: все tracked setup и новые source/helpers/tests/docs/config/locks/schemas/fixtures/bootstrap/release inputs. Excludes: dependencies/dist/Git metadata, audit/report/packaging и временные outputs; secrets не собирались. Deletions=[]. Report/packaging hashes отдельны, без self-reference.

Папка: `audit/evidence/q1a-r2-1-2026-10-25-local/`. Report, identity, complete adding patch, new-files.tar/json, deletions, tested-files.sha256, evidence.zip + внешняя checksum. Additions уже входят в patch; tar не применять повторно. Owner layer пуст. Final patch с report снова применён в пустой ordinary temporary folder; manifest/new-file hashes совпали. HEAD/branch/index сохранены. ZIP содержит неизменённый reviewer runner, frozen inputs/runners/checkers, red layer, logs/counters/fault matrices и README; личная session directory и другой неопубликованный archive не нужны. Report/patch внутри ZIP совпадают с файлами в папке по bytes.

**R2.2 OPEN:** полный C13 generated_at/expires_at format, host/owner-session/version-lock/release/public observations binding, provenance explicit target, остальные substitution/concurrency cases. R2.1 не является криптографической аутентификацией plans и не защищает от изменения trusted installer самим owner.

**Остальное OPEN / NOT RUN:** R3/Q1B/Q2–Q6, реальный privileged executor/APT provenance/S03 cutover и rollback timer, M0/service/unattended/live, AF backlog и production. **NOT RUN:** sudo/apt/systemd/SSH/UFW/Docker daemon/cgroups, credentials/OAuth/provider/model/GitHub writes, VM/VPS/provisioning, release/deploy, physical power loss. Реальны только owned local child processes; внешние effects моделируются.

Следующее действие владельца — передать локальные report/patch/new-file payload/identity/manifest/ZIP/checksum на review. Push, credentials и VPS для этого не нужны. Следующий пакет агентом не начинался. Во всех будущих agent prompts сохраняется запрет на commits/push/branches/worktree/PR/release/deploy без нового явного разрешения владельца.
