# Q1A-R2.1.1 — S03 продолжение подтверждённых операций без replay

2026-10-26, Europe/Amsterdam. **R2.1.1 package PARTIAL; R21-F01/F02 local fixes PASS; production OPEN; real-host qualification NOT RUN.** R21-F01/F02 закрыты в указанном локальном scope. Это новая проверка continuation, а не ретроактивное подтверждение прежнего A21-08. Исходные R2-F01/F02 остаются закрыты; R15-F01 не переоткрывался.

## Identity и сохранённая работа

Actual base HEAD `6281df5796ec5dd82a6fee95b058bbc970f0ed16`, tree `da6e74b369455fc10b568cb9c3075918c72186cc`, branch `master`. Initial staged/unstaged/untracked owner layer пуст. Read-only HEAD/branch/status/diff и initial index SHA-256 сохранены в `initial/`; index до/после `1afc4d4d41d717b2f451e0c20ab7c8464825830c278c54ab6da418dade1add82`. HEAD, branch и index не изменены; dependencies владельца не удалялись.

От audited `d8728f56e847a9da75b9f21d8e6e6725a9bd295e` отличаются только четыре committed audit-входа: task prompt, reviewer ZIP/checksum и audit markdown. Имена/SHA-256 — `initial/base-delta.json`. Все 143 setup inputs из предыдущего tested manifest `75973014385506fd0228e64c4d0165effdb38b267c3c94f2aa3c20ae4685ae8c` совпали с actual base archive. Замечания полностью применимы к production baseline.

Нового tested commit нет: тестировался восстановленный local tree actual base + patch. Identity — base SHA + SHA-256 `tested-files.sha256`: **0665810884ee2a558be71467723b4b3818ca21c47d06b5296479ec81803f18c0**, **148 файлов**. Manifest охватывает весь tracked setup tree и все новые setup source/test/helper/docs, включая config/locks/schemas/fixtures/bootstrap/release inputs. Исключены `dist`, `node_modules`, Git metadata, временные runtime artifacts, secrets (не использовались), audit packaging/report. Остальной неизменённый репозиторий закреплён base tree; hashes report/patch/payload записаны отдельно, без самоссылки.

Прочитаны AGENTS.md, новый аудит, R2.1 report, `plan-admission-r21.md`, CONTRACT C06/C07/C08/C09/C13 и затрагиваемые tests. CLI/config/state/plan formats, CONTRACT 1.0.0 и exit enum не менялись. Не выполнялись commit/push/создание branch/worktree/PR/merge/tag/release/deploy, `git add`/`git add -N`, reset/clean/stash.

## Before → after и независимое evidence

Исходные reviewer `access-continuation-probes.cjs` и `check-access-continuation.py` заморожены byte-for-byte. Настоящие SetupEngine и S03, внешние действия — fake counters/observations; cancel — настоящий `requestCancel`, state/receipts не подделываются. Это не live SSH qualification.

| Проверка | Actual baseline | Fixed |
|---|---|---|
| Исходная S03 матрица, 13 cases | **3 desired PASS / 10 FAIL**, harness exit0; desired oracle exit1 | **13/13 desired PASS**, oracle exit0 |
| Старый действующий plan после install/stage/arm/cutover/tailnet | exit4 `s03_observation_drifted` | exit0; каждый effect один раз |
| Explicit re-plan/review после cutover | exit0, install/stage/arm/cutover/tailnet/disarm = **2/2/2/2/1/1** | **1/1/1/1/1/1**, exit0, timer disarmed |
| Happy path и cancel после disarm | Проходили | Сохранены, нет новых intents/replay |
| Новые safe-expectation tests на baseline | **0/2 PASS**, false drift и install=2 вместо1 | Те же матрицы проходят в final suite |
| Genuine baseline v1 publication → fixed continuation | Отдельный migration measurement | **13/13** по неизменённому oracle |

F02 существовал до R2.1; этот отчёт не называет его впервые возникшим регрессом. Raw rows — `logs/access-baseline.jsonl`, `logs/access-fixed.jsonl`; product oracles — соответствующие `*-oracle.json`. Red functional tests — `logs/baseline-regression-red.log` и command JSON (exit1 ожидаем). Это две новые regression-матрицы, наложенные только как test layer на неизменённый compiled baseline; ни missing module, ни setup failure за product red не засчитывались.

`access-legacy-transition.cjs` — отдельно названная минимальная адаптация module selection: первая публикация создаётся baseline engine/S03, continuation — fixed engine/S03; facts, cancel и oracle/counts сохранены. `runner-adaptations.md` описывает это и исторические frozen adapters. Synthetic metadata-corruption/downgrade fixtures в suite явно названы synthetic; они не подменяют genuine engine-generated evidence.

## Production diff и design note

- `core/progress.ts` — единый restore/carry-forward helper после обычного evidence admission. Проверяет ordered prefix trusted producer, полную semantic identity, journal publication каждого шага и exact frontier manifest receipt (stage/config/resource/operation/attempt/hash/sequence/state hash). Не берёт произвольный последний receipt.
- `core/engine.ts` — восстанавливает predecessor в planning, предварительном all-stage admission и execution context; включает публикацию semantic operation в существующий checkpoint state; переносит только доказанный prefix в явно новый review. Generic stages и recovery algorithm не переписаны.
- `core/policy.ts` — strict bounded internal basis v2 и aliases исходных опубликованных операций. Gates/resource/risk/kind/effects/timeout/retry и остальные constraints сравниваются полностью; допустима только прежняя узкая S03 normalization observation-derived identity и подтверждённых exposure constraints.
- `stages/access.ts` — reverify frontier + immutable inputs, не зависящие от памяти stage instance. Частичный resource-level verified не скрывает незавершённую последовательность. Own cutover hashes принимаются только как подтверждённый staged target; ownership/manual/pins/templates/diff не нормализуются. Без target proof content должен остаться прежним. Unexpected changes вызывают rollback, без следующего успешного checkpoint.
- Дополнительные production files `core/types.ts`, `core/plan.ts` необходимы для typed progress context/hooks и передачи admitted prefix в producer observation во время plan. Без этой передачи после install частичный verified мог бы превратиться в публичный no-op. ProcessAdapter, state recovery writer, S04/S05/M0 не менялись.

Выбрана полная semantic reconciliation с отдельной текущей alias identity; public observation-derived IDs сохраняются. Новый plan может представлять полный каталог, но core-validated prefix однозначно определяет оставшийся suffix. Новый review не обнуляет историю. Полностью завершённая установка даёт public no-op, сохраняя внутренний полный historical catalog. Одного stripped suffix/resource ID недостаточно: helper сравнивает всю operation, кроме явно нормализуемых constraints, и требует publication/current postconditions.

`versions.setup_policy_basis_v1` остаётся тем же extensible storage key. Internal version2 добавляет для каждого completed шага `{currentId, operation, attemptId, receiptHash}`. Strict field/type/enum/hash/UUID validation, уникальность/order и прежний 64 KiB bound; новый persistent sidecar отсутствует. Вложенного/self-referencing state hash нет. Метаданные публикуются существующими state snapshot → journal checkpoint → manifest binding. До полного admission они не разрешают replay или stage success.

Arm/disarm различаются полными operations и journal publications. Manifest может компактировать arm receipt после disarm; тогда историю доказывают exact ordered bindings, а текущий frontier — retained disarm receipt. Восстановление не требует невозможного byte-equality каждого исторического промежуточного snapshot после последующих собственных effects.

Legacy v1 переносится только при наличии exact bounded schema-valid старого plan, совпадении его hash с admitted core basis, полном соответствии trusted producer из source, однозначной цепочке checkpoint bindings и current frontier. Upgrade сначала только in-memory; следующая нормальная publication записывает v2. Missing/ambiguous/malformed/foreign proof блокируется без удаления artifacts. Basisless R1.6 known progress и retained receipts с пустым completion prefix не объявляются fresh; автоматическая миграция неподдерживаемых данных запрещена и требует отдельного review/reconciliation.

Полный protocol и crash table: `setup/docs/access-continuation-r211.md`; correction note в `setup/docs/plan-admission-r21.md`. Ошибки до intent не портят известный progress. Неизвестный in-flight/effect, checkpoint без binding и final manifest faults остаются под прежними recovery rules.

## Findings → assertions

Все PASS ниже относятся только к локальным adapters/FS/processes. Raw test assertions находятся в `setup/tests/integration/q1a-r211-access.test.ts`, общая запись — `logs/final-test.log`, извлечённые counters — `logs/r211-measurements.json`.

| ID | Local status | Конкретное доказательство |
|---|---|---|
| R21-F01 / A211-01 | PASS | Original 13-case runner: baseline desired 3/13, fixed13/13; receipt/checkpoint реально создаёт engine, cancellation130 |
| R21-F02 / A211-03 | PASS | Original re-plan rows и шесть boundary cases нового теста: final counts ровно1/1/1/1/1/1, шесть intents, no replay |
| A211-02 | PASS | Six same-plan boundary rows: new engine после каждого checkpoint; null in-flight, exit0, final verified, disarmed; repeat также без replay |
| A211-04 | PASS | Original happy/disarm controls + suite fault-off happy; repeat no-op не добавляет intents |
| A211-05 | PASS | Отдельные OS processes для review, apply-cancel, resume и re-review на install/cutover/tailnet, обе ветви; disk-backed facts, distinct PIDs в R211_PROCESS |
| A211-06 | PASS | Последовательные install→arm→cutover→tailnet pauses с чередованием resume/re-plan; final шесть effects/intents, known prefix не теряется |
| A211-07 | PASS | Cutover checkpoint → ровно30min: old resume4 `plan_expired`, evidence/counts/gate expiry неизменны; fresh review продолжает без replay |
| A211-08 | PASS | Resume и re-plan × content/ownership/pin/manual/diff drift: typed refusal, hashes state/previous/manifest/journal/marker до/после равны, new intents/effects=0. Own raw hash cutover positive; unproved content/ownership during cutover →8 + rollback1, tailnet0 |
| A211-09 | PASS | Real core writer synthetic metadata negatives: missing basis, wrong stage/config/operation/attempt/receipt, arm/disarm collision, empty prefix →8 и unchanged evidence/counters. Genuine v1 transition13/13; missing/rehashed legacy plan blocks. Synthetic v1 prefix controls отдельно |
| A211-10 | PASS | Owned S03 child реально доходит через engine до effect-before-verify / checkpoint-before-binding / binding-durable IPC barriers; bounded deadlines, reader non-mutation, live foreign-lock refusal, SIGKILL только owned child, lock-only recovery не меняет evidence. Первые две фазы resume8, counts unchanged; после durable binding recover/resume0 без install replay. Fault-off happy завершает те же пути. Старые crash/fault matrices сохранены |
| A211-11 | PASS | Submitted gates/resource/risk/constraints tampering с пересчитанным hash после arm →2, zero new effects/intents. Trusted producer policy change требует новый review; новый gate не наследует approvals, после явного approval продолжение ровно однократно |
| A211-12 | PARTIAL | Final suite **446/446**, исходные429tests сохранены; original frozen guards PASS, но дополнительный S03 recovery continuation ниже остаётся OPEN; frozen33, command37, R2checker39 PASS; S00…S07 composition, Docker sessions, S05 command identity, recovery/crash/fault controls — без ослабления oracle |

Числа 33/37/39 пересекаются: command37 включает aggregate прежних33, R2checker39 содержит служебные checks. Они **не** складываются в109 уникальных сценариев. Baseline назначения различаются: S03 actual6281df5 (setup-identicald8728f5); original R2 ca6d0b6 — 5safe/3unsafe; historical command b888082. Fixed R2 — 8safe/0unsafe. Harness exit0 не является acceptance.

Typed refusal: inconsistent submitted producer policy —2; missing/inconsistent publication/basis/frontier —8; existing S03 raw postcondition/input mismatch —4 `s03_observation_drifted`; additional immutable review drift —8 `s03_progress_input_drift`; expired plan/missing approval —4; unknown effect/generation/binding —8. Сохранены прежние stage-specific manual codes, gate expiry и строгий30-minute TTL; resume/gate approve не обновляют время старого plan.

## Фактическая validation

Final reconstructed checkout: `logs/commands.json` содержит actual argv/cwd/exit/elapsed; `logs/environment.json` — runtime/OS/arch/UID. **v24.12.0**, npm **11.6.2**, **macOS-15.5-arm64-arm-64bit-Mach-O / arm64**, UID **501**. Это ordinary-owner local validation, не квалификация root installer/Ubuntu VPS.

| Команда в reconstructed copy | Exit / outcome |
|---|---|
| `node --version` |0, v24.12.0 |
| `npm --version` |0, 11.6.2 |
| `npm --prefix setup ci --ignore-scripts --no-audit --no-fund` |0 |
| `npm --prefix setup run typecheck --silent` |0 |
| `npm --prefix setup run test --silent` |0, 446 passed,0failed/0cancelled/0skipped |
| Original S03 baseline oracle `--expect fixed` |1 ожидаемо,10 product failures |
| Original S03 fixed oracle / genuine legacy-transition oracle |0 /0, по13/13 |
| Frozen comparisons / command / R2 oracle |0,33 /37 /39 assertions |

148 source/test/config/docs inputs совпадают с workspace и реконструированной копией; hashes до/после tests одинаковы (`logs/hashes-before.json`, `hashes-after.json`). Тесты реально запускались на восстановленных bytes, не только `git apply --check`. Последующая упаковка добавляет только отчёт/packaging; tested setup bytes не менялись. Полный package дополнительно восстановлен с full patch и проверен manifest.

Exploratory/intermediate logs сохранены с классификацией. Первый TypeScript build выявил ошибку narrowing; emitted-JS результаты не считаются успешной validation. Успешные промежуточные429/445/446 и targeted15/16/17 прогоны не выдаются за final bytes. После последних code edits (точный legacy plan и canonical key order staged proof) final validation выполнена заново. Исторический reviewer intermediate с ошибочным ожиданием cancel6 не использовался: контрактный cancel130.

## Дополнительный существовавший recovery blocker — OPEN

После final validation выполнен более широкий S03-specific контроль: successful apply → explicit re-plan (public no-op) → потеря только primary → recover → resume. И direct, и plan-first ветви возвращают recover0/repeat0, затем resume2 `plan_policy_mismatch`. Тот же исход воспроизведён на **неизменённом baseline production**, отдельно от fixed. Metadata-only re-plan меняет policy basis, а восстановленный snapshot может содержать прежний reviewed source; core правильно не подменяет его новым submitted plan без review. Счётчики остаются1/1/1/1/1/1, checkpoint сохраняется; replay/unknown bypass нет. Explicit fresh plan/review после recovery даёт resume0 без дополнительных effects.

Это дополнительное ограничение безопасного продолжения, а не новый контрпример к исправленным checkpoint-cancel paths R21-F01/F02 и не новый регресс. Original C01/frozen recovery assertions проходят, но они не доказывают этот расширенный S03 case. Поэтому пакет честно помечен **PARTIAL**, A211-12 — PARTIAL; не объявляется общий recovery PASS только на основании446 зелёных tests.

Исходный дополнительный desired runner `runners/access-final-recovery.cjs` сохранён с неизменным требованием resume0: baseline/fixed дают exit1; raw assertion logs — `logs/additional-s03-recovery-*-desired-red.log`. Отдельный measurement runner не ослабляет этот oracle: он записывает `desired_acceptance:false`, обе фазы и проверенный explicit-review workaround в `logs/additional-s03-recovery-baseline.jsonl` / `*-fixed.jsonl`; actual argv/elapsed — `additional-recovery-commands.json`. В этих logs **4/4 desired failures**, а harness completion не является product PASS.

Автоматически принимать новый plan или переносить утраченную review identity из submitted JSON было бы ослаблением trusted-policy boundary. Согласованная reconciliation policy/recovery metadata — отдельный review scope; state/journal recovery protocol в этом пакете не переписан. Никакие basis/receipts/manifest/marker для обхода отказа не удалялись. Следующий шаг — human review локального пакета и отдельное назначение этого остатка; R2.2 не начат автоматически.

## Remaining risks и handoff

**Code status:** R21-F01/F02 закрыты исходным oracle и новыми continuation assertions. Пакет в целом PARTIAL из-за дополнительного recovery-path ниже; A211-12 не заявляется безоговорочным PASS. External drift/new completed-policy semantics требуют отдельной reconciliation; неподдерживаемый legacy proof честно блокируется, не стирается. Shared resource не является identity. Это не защита от owner, меняющего сам trusted installer, и не полный OS-level TOCTOU/process-tree proof.

**Local validation:** PASS на фактическом Node24/macOS; Ubuntu24.04amd64 live qualification не проводилась. Physical power loss NOT RUN. Не выполнялись реальные sudo/APT/systemd/SSH/UFW/Docker daemon, OAuth/credentials/provider/model/GitHub writes, VM/VPS/provisioning или deploy.

**Production/real-host:** OPEN / NOT RUN. Реальный NodeAccessAdapter cutover/timer/rollback path по-прежнему отдельный **Q2 code blocker**, а не просто непройденный live test. R2.2 full C13 serialization (`generated_at/expires_at`) и host/owner-session/version-lock/release/observations binding, остальные concurrency cases; R3/Q1B/Q2–Q6, M0/service/live, AF backlog/Q1A/AF-05/06 и production автоматически не закрываются.

Следующий шаг владельца — независимое review локальных файлов: report, `full-local.patch`, `new-files.tar`/`new-files.json`, `tested-files.sha256`, `identity.json`, `evidence.zip` и внешний checksum. Новые файлы уже включены в patch; tar — альтернативный явный payload, не применять повторно. GitHub master не содержит этих локальных правок, поэтому одной ссылки на master недостаточно. Commit/push/новая branch/worktree/PR, credentials или VPS для review не нужны и не разрешены этим пакетом. Эти запреты должны сохраняться в любых следующих промптах для ИИ-агентов.
