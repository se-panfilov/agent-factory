# Q1A-R2.2 — локальный результат, 2026-10-26

**Итог: PARTIAL.** C13 и исправления R22-F01/F02/F03 реализованы; локальные product assertions проходят. Полный combined replay один раз остановился до cases/META в frozen comparison, поэтому стабильность independent evidence не объявляется доказанной. Это сохранённый harness failure, не product PASS и не доказанный регресс S03. Причина R211-O02 остаётся OPEN. Production OPEN; real-host / privileged / VM / live qualification NOT RUN.

## База и сохранение работы

Actual HEAD `f12791cf8416fc115d45246f0531ce103fa5e2e8`, tree `f5c8bb806b39235bdcee465bc41e08969f1a54e6`, branch `master`. От reviewed `117a71e3607659e97509b99c1662131c3970c112` отличаются только четыре audit/task/evidence файла. Побайтно проверены все148 исходных setup inputs; список и hashes — `initial/reviewed-input-equivalence.json`, delta — `initial/base-delta.json`.

Начальное дерево было чистым, staged/unstaged/new-file owner content layer пуст. Initial index SHA256 `bb58fa875f297b413b4afe6b8f6ca022347d738a0e318875acb9b4e788f61b5c`. Во время работы index изменился вне команд агента: наблюдались `da69de26f0ac45ebbfb5c743e91085b7a772d05ee905b2a5f5096987ca4fc780`, затем `034d62cb0e0531b14507cf1052671957334bb2878b8c04b7ae5cdbc81baaa152`. Происхождение изменения не установлено. Сохранены staged/unstaged patches, stage entries и status snapshots в `initial/index-event-{1,2}`; агент не отменял staging и не восстанавливал прежний index. Конечный checksum/status записан отдельно в identity. Исходный HEAD/branch сохранены. Никаких commits/push/branches/worktrees/PR/merge/tag/release/deploy, git add/add-N/reset/clean/stash агент не выполнял.

Нового tested commit нет. Проверены локальные bytes: **157 setup input files**, manifest SHA256 `40750081b9109e98c46fe9bed1a4522d92e19f2ef31e9ef7784184b2dad9bc68`. Восстановление: actual-base archive + full-local.patch, без index. Source hashes до/после ci/typecheck/tests/independent matrices совпали. Report/package/runner hashes отделены от source manifest, без самоссылки.

## Production changes и design note

`setup/schemas/plan.schema.json`, `core/types.ts`, `core/plan.ts`, `plan-format.ts` реализуют flat C13 execution file. Старые `stages/created_at` — только строго декодированный внутренний view или historical evidence, не permissive execution parser. Public CLI/config/state и exit-code enum не менялись; plan representation меняется согласно назначенному C13 scope. Дополнительные поля явно описаны строгой schema: owner_session, target, stage_scope, release_context, risk/constraints/execution classification. Неизвестные поля/actions, дубликаты, foreign IDs и semantic tampering запрещены. Hash — рекурсивно canonical JSON, значимый array order, без plan_hash; self-hash не authorization.

Все реальные producers получают literal concrete action. Изменения остальных stage modules ограничены этими declarations: поведение S03/S04/S05 не переписано. Default registry не содержит synthetic producer `fixture.counter`. Consumer сверяет полную operation semantics с trusted producer; submitted action/string/resource не выбирает произвольный executable. C13 expected_before содержит hashes constraints/source/version-lock, expected_after связан с существующим action-specific verifier; bounded timeout/retry, gates/risk/effects не потеряны.

`plan-context.ts` и минимальные identity методы `adapters/process.ts` получают machine/OS/arch, ordinary configured owner, boot и Linux audit loginuid/sessionid. Новые CLI PIDs одной session допустимы; новый login/boot требует review/approval. Unset audit session fail-closed, без env/PID/random fallback. Machine identity не включает boot. `adapters/filesystem.ts` добавляет bounded streaming hash actual artifact; validated version-lock hash охватывает точные UTF-8 bytes, а не путь. Release-use closure проверяет actual archive SHA, S05/S06 policy дополнительно связывает manifest/commands/deployed content/pins; host-only scope не требует отсутствующего M0. Реальный M0 этим не квалифицирован.

`engine.ts`, `policy.ts`, `progress.ts`, `plan-history.ts`, `state.ts` связывают review с exact context/target/closure и admitted progress. Core metadata version3 сохраняет полный semantic catalog, current frontier и original attempt/receipt/checkpoint identity. S03 v1/v2 migrations разрешены только через exact semantic/ordered-prefix/current-postcondition proof, включая shared arm/disarm resource. Generic completion требует journal/manifest binding; строка completed не разрешение. После changed config generic progress не наследует trust; старые receipts сохраняются. Stage observe не затирает reserved core metadata.

Publication: сначала existing atomic state protocol публикует **prepared review + catalog**, затем atomic C13 plan, затем **committed review**. Prepared snapshot не разрешает approval/effect. Никакого параллельного authorization sidecar или автоматического promotion после recovery. Старые планы требуют explicit new producer review; timestamps/approvals не продлеваются. Legacy historical parser и duplicate-key parser строго bounded; неоднозначная история сохраняется и блокируется.

Admission выполняет одинаковые request/context/producer checks при approve, после installation lock и до каждого следующего effect, повторно после read-only probes/hashing. Own verified transitions используют published frontier, а не переписывание approved plan. `generated_at/expires_at` — canonical real UTC milliseconds, ровно30минут, один injected clock; future generation запрещена, `now >= expires_at` блокирует следующее действие. Уже начатое bounded действие может подтвердить progress до отказа на следующей границе.

Полная модель, limits, migration/crash table и причины дополнительных production files — `setup/docs/plan-context-r22.md`. `strict-json.ts` нужен для duplicate decoded keys до schema/hash; `action-postconditions.ts` — единые action-specific descriptions; `plan-history.ts` — historical-only migration, никогда execution fallback. Старые docs дополнены supersession notes, исторические отчёты не переписаны.

## Findings → proofs

| Finding | Code status | Local proof |
|---|---|---|
| R22-F01 host/session | FIXED | B02 foreign machine8 и B03 ended boot/session4, APT0/0/0; same-context B01 exit0/counts1/1/1; approve/apply/resume negatives и fresh-review positives |
| R22-F02 lock bytes | FIXED | B04 typed stale-context8/counts0/0/0; same-path/missing/invalid/truncated/symlink controls; bounded actual lock read |
| R22-F03 C13/context | IMPLEMENTED; acceptance PARTIAL | Flat schema round-trip, native tampering/TTL/target/release/progress/crash assertions PASS; independent combined-run stability OPEN, A22-17 |

Baseline current f12791c (setup-identical117a71e): **2/5 desired PASS**, desired oracle exit1; observed-current oracle0 только измеряет исходный дефект. Fixed C13 fixture adapter: **5/5 desired PASS**, oracle0. Для B02/B03/B04 baseline effects1/1/1 → fixed0/0/0; B01 остаётся1/1/1; B05 unapproved4/0/0/0. Подмена Docker pin в B04 доказывает общий lock binding, не установку этого pin.

## Acceptance matrix

Ссылки ниже относительно `audit/evidence/q1a-r2-2-2026-10-26-local/`. Конкретные имена assertions находятся в полном `logs/final-test.log`, machine rows — в соответствующих JSONL. Новые native assertions — `setup/tests/integration/q1a-r22-context.test.ts`; прежние смыслы R11/R12/R13/K/T/U/V/W/A21/A211 сохранены, IDs не переназначались.

| ID | Status | Assertion / evidence |
|---|---|---|
| A22-01 | PASS | Native round-trip, canonical keys/arrays, closed action/expected semantics, duplicate decoded keys, unknown fields/actions/dates; final-test A22-01, contracts unit tests |
| A22-02 | PASS | Original context baseline oracle2/5 expected-red; C13 adapted fixed5/5, counts/unchanged request asserted; logs/context-{baseline,fixed}* |
| A22-03 | PASS local | Same session fresh engines/owned PIDs; machine/OS/arch/missing/root/wrong-owner negatives before intent, production parser/audit-session method tests. Native OS login itself NOT RUN |
| A22-04 | PASS local | New boot/login old approval refuses; fresh review positive; real S03 prefix/new login and realistic Docker effective-group relogin retain completed effects |
| A22-05 | PASS | Actual valid lock bytes, replacement/missing/invalid/truncated/symlink; fresh reviewed replacement positive; evidence unchanged on refusal |
| A22-06 | PASS local | Actual bounded archive hash + lock-bound native context; archive swap and S05 manifest/entry drift block before probes. R15/W tests preserve checked executable identity; host-only no-M0 positive |
| A22-07 | PASS | Producer significant projection excludes timestamps; A21-12 drift; S03 own hashes/ordered frontier and S02 own refresh/TTL checkpoint remain resumable |
| A22-08 | PASS | Exact selected/explicit closure incl no-op dependencies; target/subset/order/foreign operation tampering refuses; A21 composition/target tests |
| A22-09 | PASS | Same context checker in approve/apply/resume; root/wrong owner/session/gate resource/hash/expired guards; readonly gate-list/status never repair malformed review |
| A22-10 | PASS | Native30min−1ms/exact/+1ms/future/impossible/duration + gate-free R2 controls; completed refresh crossing TTL blocks second effect, fresh review no replay |
| A22-11 | PASS | Original S03 oracle13/13; genuine6281df5 v1→C13 explicit review13/13; actual R2.1.1 v2 base→C13 explicit review13/13; original publications untouched |
| A22-12 | PASS local | Owned subprocess PIDs/counts in final-test R211_PROCESS; sequential pauses/TTL/new review; new Docker session test and original crash children preserve progress |
| A22-13 | PASS focused | A21 controlled config/plan lock swaps; A22 lock-byte/release swap at actual lock and lock change inside completed refresh; K10/J11/U08 concurrent lock/reader controls. General concurrency qualification remains R3 |
| A22-14 | PASS local | Actual prepared/final-review ENOSPC on/off, malformed review and bad generic publication negatives; inherited U07 manifest/checkpoint write/fsync/rename/dir-fsync and owned SIGKILL matrix |
| A22-15 | PASS (limitation preserved) | Original final-recovery desired runner retained known-red exit1; measurements show recover0/repeat0/resume8, explicit fresh-review resume0, all S03 counts unchanged, checkpoint retained |
| A22-16 | PASS | All446 prior test meanings retained; total485/485; frozen33, command37, R2checker39; full real-producer S00…S07 composition with fake externals, Docker/session and S05 commands |
| A22-17 | PARTIAL | Full raw argv/cwd/exits/PIDs/counts/hashes and classifications retained; completeness checker passes complete separate matrices. Combined replay had zero-row deadline failure; traced replays complete but root cause/stability unproven (R211-O02) |
| A22-18 | PASS | Actual-base reconstruction157 input files; SHA manifest before/after final validation identical; full patch/new-file payload/reconstruction checked; report/package hashes separate |

## Commands and actual results

В обычной reconstructed copy `/private/tmp/af-r22/final-tree`:

| Command | Exit / result |
|---|---|
| node --version | 0, v24.12.0 |
| npm --version | 0, 11.6.2 |
| npm --prefix setup ci --ignore-scripts --no-audit --no-fund | 0 |
| npm --prefix setup run typecheck --silent | 0 |
| npm --prefix setup run test --silent | 0, **485 passed /0 failed /0 skipped**, 107358.238958ms |

Actual host macOS15.5 arm64, UID501; fake target Ubuntu24.04 amd64/ordinary owner1000. This is not Ubuntu/root/privileged installer qualification. No `process.versions` substitution, sudo or host-mutation switches. Only harmless owned children execute locally. Full command ledger includes argv/cwd/elapsed/exit and expected known-red exits.

Independent complete product checks: context5/5; original S03 13/13; genuine v1 and v2 reviewed migration13/13 each; frozen33; command37 (includes prior33 aggregate); R2checker39 (includes service checks). **Do not add these overlapping counts.** Old unsafe baselines retain their original roles: ca6d0b6 for R2 and b888082 for command identity. Final full composition reports application probes6, APT1/1/1, Docker install/probe1, cutover1, image build1; these are fake external effects.

## Failures retained, not hidden

Exploratory source/fixture/schema migration failures and red suites are under `intermediate/`, with classification. They are not final validation. The original baseline context red is a product counterexample. Early legacy adapter used the wrong injected architecture; S06 no-op adapter lacked a real owned archive; these were input/harness failures corrected by explicit fixture inputs, never production bypasses. Completeness checker initially confused a numeric CLI status exit0 with string PASS; corrected without changing product oracle.

The first reconstructed combined replay stopped at `fixed-comparison.jsonl`, exit2, only deadline message, no cases/META. Its raw output/ledger remain in `intermediate/reconstructed-driver-first/`. Diagnostic FS trace runs retained the same product runner/oracles/counters, completed13 rows, and check exact owned FS phases; instrumentation can affect timing, so this is **not** a stability repair. No claim that R211-O02 is fixed; no random-repeat-to-green acceptance. The final checker explicitly refuses empty/incomplete matrices. Frozen33 asserts complete traced measurements, not the failed combined run.

## Remaining scope and handoff

R211-O01 stays OPEN in R3: recovered prepared review is not authorization; explicit fresh review is the proven no-replay workaround. R211-O02 runner stability/cause OPEN. OS-level TOCTOU and privileged safe writes, real S03 cutover/timer stubs, Q1B supervisor, Q2–Q6, R3, application M0/service/live, AF backlog and production remain OPEN / NOT RUN as applicable. This package neither provisions nor deploys a factory.

Передать на независимое review локальный report, full-local.patch, new-files.tar/json, identity.json, tested-files.sha256, evidence.zip и внешний checksum. Изменений на GitHub от агента нет; ссылка на master не заменяет локальные patch/new files/manifest. Следующие работы требуют отдельного задания. **Не коммитить, не пушить, не создавать ветки/worktree/PR, merge/tag/release/deploy и не использовать index для packaging в любых следующих промптах агента.**
