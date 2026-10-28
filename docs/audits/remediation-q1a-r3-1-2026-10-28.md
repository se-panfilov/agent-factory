# Q1A-R3.1 — локальный remediation, 28 октября 2026

**R31-F01…F04 исправлены на code level.** Финальный локальный run:645/645 tests, новые56 R31 tests и прежние589 сохранены; все обязательные matrices complete. Actual UID501/macOS, root-isolated Linux environment **NOT RUN**. Это local logic verification, не production qualification. O01 honest8/fresh-review принят и сохранён; historical O02 cause OPEN.

Никаких commits/push/branches/worktree/PR/staging/index (включая git add -N)/merge/tag/release/deploy. Всё остаётся локально. Эти запреты сохраняются и для любых последующих AI-agent prompts. Делегирования агентам, remote messages/mutations, real credentials, provider/model calls и provision не было.

## Исходные identities и owner layer

Проверенный product baseline: `e217f397b952942b62e847788dc2e6698ad6d7e5`, tree `41fe20304e340133bd7e217aceea674c466015e3`. Начальный и финальный HEAD: **ad274add0a7ed0a5e0923363ce9e9000bef7c013**, tree **63f15f339f7520f382ec9e5eb485c7572d5304b7**, branch master. Delta e217→ad274 содержит только audit/R31 prompt, R3 review и input archive; setup delta отсутствует. Named reconstruction base — ad274, product baseline не переименован в audit commit.

Полная capture сделана до source edits: HEAD/tree/branch/porcelain, index entries и bytes/SHA256, staged/unstaged patches, hashes relevant tracked/untracked inputs. Index SHA256 **233115de2884abfdcdf8e08e393b3c32ea0fbb308be5cf8bca4872cd23b376ba**. Три owner staged pyc сохранены без удаления/перезаписи; source/package generation не использует index. Внешнего HEAD/index сдвига в этом проходе не наблюдалось. Отсутствующие ранние bytes прежнего R3 не выдумывались и не стали blocker нового исправления.

Reviewer R3-evidence.zip: SHA256 **1af65770d6a9d48d8fe520905b01488d7eb56e2066b187d4e34c4bce24591293**, прочитан из R3-checksums и независимо вычислен. ZIP распакован отдельно после path/type/CRC checks, README прочитан. Все270 прежних tested inputs проверены на exact archive baseline e217; match270/270. Original probes/checkers/raw сохраняются отдельно.

Среда: bundled Node24.22.1, npm11.17.0, actual UID501, macOS/APFS development FS. Application test identity явно UID1000/factory/Ubuntu24/amd64; actual FS ownership проверяется отдельно, без process.getuid monkeypatch/global fake identity/OS-check weakening. Root CLI negative controls используют explicit root ProcessAdapter и сохраняют отказ до effects. Реальная Linux/UID0 isolated suite здесь недоступна и не выдаётся за PASS.

## Четыре исправления

**F01 — strict cancellation parser.** Bounded decode/control metadata остаются прежними; lstat ENOENT — единственное доказательство отсутствия. Permission errors, broken symlinks и неизвестная metadata не означают «запроса нет». Отдельный decodeCancel проверяет exact schema/version/fields/full owner до comparison. Unknown version, missing/extra/wrong-type fields, malformed owner/JSON/UTF8/duplicate keys/oversize/unsafe metadata→typed8 cancel_evidence_unknown, no S02 intent/effect, файл сохранён. Только точный известный legacy format распознаётся без version; он никогда не получает authority. Valid stale/foreign generations — no-op. Matching request130 сохраняется. Дополнительные async metadata reads заканчиваются внутри прежнего consume path до final R221 fence/TTL/gates; после fence await не добавлены.

**F02 — independent Docker discovery.** Источник обязанности — существующий поддержанный S05→S04 deployment graph, связанный с доверенным текущим S05 deployment proof. Поддержанного Docker-free S05 profile/proof нет. Поэтому absent/empty/stale/incomplete/unsafe advisory inventory не отключает fixed-label live discovery и не выбирает arbitrary argv. Unusable advisory отмечается в outcome, а отсутствие ресурсов доказывает только валидный live empty response. Unknown daemon/permission/output/ownership —8, не empty/foreign. Каждый target inspect-ится до stop и после; foreign не трогается. Нет sudo docker, установки Docker, prune или нового host executor. Для недоступного daemon — конкретный manual recovery, без автоматического install/retry.

**F03 — единый emergency failure outcome.** EmergencyFailure сохраняет code/C03 и machine-readable outcome в существующем envelope.data: phase/boundary, PAUSED prior/exists/publication/prior_preserved, attempted, confirmed_stopped, unknown, stopped/skipped containers, discovery/advisory status. Returned failures и rejected process/FS/admission errors больше не выпадают в unexpected_error/fresh-plan retry. После publication/attempted effects partial/unknown→8, retryable=false, manual inspect/reconcile; confirmed prefix не теряется. До trusted admission прежние typed3/5/9 refusal сохраняются. Нет retries/rollback/unpause.

publishControl получил только optional synchronous observer фаз, без изменения write/fsync/rename/fsync-parent ordering. PAUSED failure outcomes различают not_published, published_unconfirmed и durable; old marker проверяется и сохраняется при неуспешной замене. Rename adapter, выполнивший syscall и затем throw, распознаётся по actual safe bytes/identity, но durability не выдумывается. Прежний cancel/mutex protocol не переписан. Trusted missing-status fixture создаётся **до genuine S05 publication** и достигает emergency_postcondition_missing после одного stop; command/status capability не изобретается. Service unsupported5 сохранён.

**F04 — mandatory explicit process identity.** requestCancel требует ProcessAdapter и не использует actual-UID fallback. В helper r211-access используется тот же proc, что передан engine; context test использует q.proc; stage-A test разделяет один существующий FakeProcessAdapter с engine вместо второго ожидаемого экземпляра. Все22 current source/selected standalone calls проверены project TypeScript AST census:3 arguments. Current S03/R3 standalone copies передают existing r14Process. Genuine historical first publications используют неизменный old module/API; существующий current-FS statfs bridge сохранён. Historical originals не редактировались. Actual UID и injected UID раздельны.

## Changed files

Production: setup/src/core/lock.ts, control-files.ts, engine.ts, operations/emergency.ts. Tests/helpers: r211-access.ts, r3-protocol.ts; integration/core-q1a.test.ts, q1a-r22-context.test.ts; новый q1a-r31-boundaries.test.ts. Docs: lock-cancel-r3.md, plan-context-r22.md, privileges.md, operations.md. Отдельные external mapped runners/checkers и этот report входят в package payload.

Dependencies/pins/registries, CONTRACT1.0.0/public CLI/config/C13/state schemas не менялись. Lock identity/liveness/mutex/non-reclaiming guard/resource-aware quarantine, exact journal/receipt bindings, R221 finite admission, TTL/gates, prepared/committed review и no-replay сохранены. Missing M0/M1/M2 не реализовывались. Никакой process-local trust cache или broad executor не добавлен.

## A31 acceptance

| ID | Статус | Фактическое evidence |
|---|---|---|
| A31-01 | PASS | Original exact-e217 baseline14 complete,7 desired red; collector0/baseline0/desired1, separate stdout/stderr/exits/durations, hooks1. |
| A31-02 | PASS | Actual engine/S02 invalid modern formats/read/type/metadata→8, calls/events0, exact request hashes retained. |
| A31-03 | PASS | Matching130; stale/foreign/recognised legacy/null legacy/no request→0 и1/1/1; full12 target event sequence. |
| A31-04 | PASS local | Прежние74 R3 tests, atomic faults/generation barriers/prefix receipt/no-replay и R221 boundary14 unchanged. |
| A31-05 | PASS | Same own+foreign fake live facts→same fixed discovery при present/absent/empty/stale/incomplete/unsafe advisory; own stop подтверждён. |
| A31-06 | PASS local | Live empty→verified_empty; unavailable/rejected daemon, malformed/truncated inspection не empty/foreign, typed8. |
| A31-07 | PASS local | Own stop+post-inspect Running=false; foreign exact ID untouched/reported; raw sudo/shell/unsafe label/ID/path/root controls сохранены. |
| A31-08 | PASS | Returned/rejected failures, including EIO after confirmed prefix and late witness failure→8 с exact prefix/unknown, PAUSED и manual next action. |
| A31-09 | PASS local |12 PAUSED fault cases (write/file-sync/rename before+after/parent-sync/post-sync cleanup × old/new), actual hashes/publication state; genuine missing-status branch reached. Physical power loss NOT RUN. |
| A31-10 | PASS code / NOT RUN root environment | Mandatory API,22 explicit matching current calls; root/foreign assertions unchanged. Full actual Linux UID0 environment NOT RUN. |
| A31-11 | PASS on actual UID501 | Final645/645, old589 retained, new56; fail/cancelled/skipped/todo0, no assertions removed/skipped. |
| A31-12 | PASS local | R31/R3 по14; R221 boundary14/context5; S03/v1/v2 по13; O01 honest8+explicit review/no-replay; frozen33 mapped C01, command37/R2-checker39 complete. Overlap не суммируется. |
| A31-13 | PASS completeness / OPEN O02 cause | Exact ordered unique IDs/META/counts/predicates; one complete final run, instrumentation0, no splicing. Historical cause не объявлена найденной. |
| A31-14 | PASS local |167 source +119 runner/fixture/reference inputs=286; before/after/current/snapshot equality, reconstruction verification separately sealed; owner staged bytes/index preserved. |

## Commands, attempts и ограничения результата

Baseline: git archive e217 в ordinary temp directory; Node24; npm --prefix setup ci --ignore-scripts --no-audit --no-fund; build; original r31-boundary-probes; original checker baseline/desired.14 complete/7 PASS/7 FAIL. Deliberate red — baseline подтверждения дефектов, не unexpected runtime failure.

Targeted tests:127/127 (old74 R3 + initial53 new), затем7/7 identity/admission tests, и56/56 full final R31 cases с broken-symlink/metadata checks. Original reviewer collector после fixes desired14/14. Static current API census22 calls. Эти результаты отдельные; ими не склеен final run.

Intended attempt1 остановился на typecheck2, **suite/matrices ещё не запускались**: TS2345 в новом тесте `.map(JSON.parse)` (reviver/index callback types). Raw ledger/stdout/stderr/manifest и old test bytes сохранены в attempt-1. Исправление только `.map(line => JSON.parse(line))`; compiler flags/dependencies не менялись. Targeted typecheck затем0. Это установленная static test-code ошибка, не O02 и не unexplained runner incompleteness; instrumentation не требовалась.

**Final intended attempt2** имеет собственный ledger от Node/npm/ci/typecheck/test до всех original/mapped matrices и predicates. Source/runner hashes до/после одинаковы286/286. Suite645/645; R31 desired14/14 и additional machine-outcome predicates14/14; R3 desired14/14; R3 completeness controls8/8, inherited controls13/13; boundary14/context5; S03 и genuine v1/v2 по13. Mapped frozen33, command37/R2-checker39 PASS. Original O01/C01 auto-success expectations остаются отдельно known-red; принятый mapping не менялся. Полный final replay COMPLETE, instrumentation0, no splicing. Проверки final-inherited-check и final-r31-check exit0; exact new56 и preserved R3 74 ordered names подтверждены. Полный suite занял примерно331s; timeouts не увеличивались ради green.

Все фактические argv/cwd/PID/exits/signals/durations — inherited/logs/commands.json, baseline-ledger, targeted-probe-ledger, final-checks-ledger. Stdout/stderr раздельны. Npm ci выполнен только в owned snapshots, dependencies владельца не трогались. Reconstruction/packing commands и exits фиксируются package-ledger.json. Ни branches/worktree, ни index для diff enrollment не применяются.

R211-O01: honest recovery8/fresh review/no-replay принят и сохранён. Prepared metadata не авторизует эффект; gates/TTL не продлеваются. Original historical raw red сохранён, не переименован в PASS. O02 historical cause **OPEN**: прежний UID mismatch и новая static type ошибка не объявлены её причиной. Необъяснённых incomplete runners в final attempt нет; повторов до случайного green не было.

NOT RUN: actual Linux/UID0 root-isolated run и ordinary-owner/PAM host session; real sudo/APT/systemd/SSH/UFW/Docker daemon; credentials/OAuth/providers/models; VM/VPS; physical crash/power loss; полный process-tree supervisor и общий deadline многокомандного emergency; hostile same-UID/root FS isolation; production M0/M1/M2/factory qualification. Q1B/Q2–Q6 не выполнялись. Существующие guard/boot/resource manual blockers остаются honest boundaries.

## Handoff

Пять файлов: report; audit/evidence/q1a-r3-1-2026-10-28-local/full-local.patch; tested-files.sha256; evidence.zip; evidence.zip.sha256. README указывает named base, disjoint owner/agent layers, однократное применение full patch и исключённую self-referential seal metadata. Нет new-files.tar или повторного применения новых файлов; old ZIP/node_modules/dist/repository/temp trees не упакованы. Reconstruction сравнивает все286 hashes и payload bytes до sealing.

Готово к human code review в локальном объёме, с явным NOT RUN второй реальной UID-среды. Единственное действие владельца — **передать пять файлов reviewer**. Production VPS, privileged run и credentials для завершения этого задания не нужны.
