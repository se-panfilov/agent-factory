# Q1A-R3 — локальный remediation и evidence, 27 октября 2026

R3-F01…F04 исправлены в локальном коде; R211-O01 обработан через честный exit8/fresh-review outcome. Production, Q1B/Q2–Q6 и приложение фабрики не квалифицированы. Только локальные изменения; commit/push/branches/worktree/PR/staging/index/merge/tag/release/deploy не выполнялись и не разрешены этим отчётом или будущими AI-промптами. Сообщений и изменений удалённых сервисов не было.

## Identities и ограничения provenance

Первая наблюдаемая точка: HEAD `134ecd884ab77f537f1890b3dd456cc6592090ad`, tree `58a212fa5a30df32437db021f536338507890c47`, master; index SHA256 `7d93f9b3ffb62ae9eb7864ebfb363eb1a38503720369fd25f396e4a8fdf26ef8`. Porcelain показывал owner audit files: AM R3 prompt, A R221 ZIP, A historical pyc, AM R221 audit.

**Внешнее изменение произошло до первого полного byte capture.** `initial/identity`, `initial/status`, `initial/index.bytes`, hashes и staged/unstaged patches уже фиксируют HEAD `b92e833c3d743d2f15975ee6433b453f07f173b8`, tree `dde4eb40ea514a7000714709773fd1a34906a6dd`, index SHA256 `e322277c93daf8b8fbaab665357b15778e4b27ed725b6548407be4248743d190`. Это было до agent source edits. Delta 134ecd→b92e833 — audit-only; setup идентичен. Событие не приписывается ни агенту, ни владельцу. Первая index SHA/porcelain сохранены; доступные исходные staged text blobs извлечены по их точным object IDs. **Полных bytes раннего index и исходного unstaged split до события нет.** Первые commentary об исходном полном сохранении были неточны; окончательная оценка ограничена этим фактом.

Named reconstruction base: **b92e833…**; product baseline: **134ecd…**. Owner layer уже присутствует в named base, кроме изначально staged pyc; этот binary включён отдельно от agent delta. Agent не менял index/HEAD и не делал reset/clean/stash/checkout. Полный capture до source edits и после внешнего события сохранён. Финальный index сравнивается именно с последним полностью сохранённым e322277…, а не выдаётся за совпадение с 7d93f9….

Reviewer `R221-evidence.zip` SHA256: `e6dee72f1f516cf2c3d7833b468cf0781abc252db64e59afcfc7cc8410eb452c`; значение прочитано из R221-checksums и независимо вычислено. Полный inventory исходных tracked/untracked inputs — `initial/input-hashes.json`. Старые ZIP не копируются рекурсивно в transport package.

Среда: macOS/APFS development FS, Node **24.22.1**, npm **11.17.0**, actual UID **501**; application identity в fixtures явно UID1000/factory/Ubuntu24/amd64. FS metadata проверяется против actual OS identity. Node/runtime/bootstrap/deployment/daemon facts в trusted fixture — явно synthetic; это не production pins. Owner/OS проверки ради root не ослаблялись. Первое ошибочное baseline measurement на Node26 сохранено отдельно; в baseline acceptance засчитывается только повтор на bundled Node24.

## Изменения и протокол

Production files:

- `setup/src/core/lock.ts`: bounded strict owner schema, full generation, alive/dead/unknown, conservative boot/PID-reuse treatment, общий protocol mutex и admission до quarantine, durable generation-bound cancel.
- `setup/src/core/control-files.ts` (новый): ordinary-owner, safe directories/JSON, unique private temp/file-fsync/rename/parent-fsync publication.
- `setup/src/adapters/filesystem.ts`: actual statfs classification для поддержанных local atomic semantics; unknown блокируется.
- `setup/src/adapters/process.ts`: proc comm parser, ESRCH/EPERM tri-state, cwd, Linux running executable byte identity для installed Node stop adapter.
- `setup/src/core/engine.ts`: cancellation после долгих reads до R221 metadata fence, unconfirmed in-flight/cleanup→8, ordinary-owner cancel/recover, честный recovery review outcome.
- `setup/src/operations/emergency.ts`: journal-bound S05 deployment proof, bounded strict manifest/current bytes/runtime/path checks, durable PAUSED, confined Node/cwd dispatch, status and daemon postconditions, foreign/unknown separation.

Tests: новые `tests/helpers/r3-protocol.ts` и `tests/integration/q1a-r3-protocol.test.ts`; узкие updates в core-engine, core-q1a-r1-state-recovery, operations, q1a-r15-stages и q1a-r211-access. Обновлены explicit valid test identities и FS delegation; старые assertions automatic takeover заменены **более строгими** exit8+lock/evidence-preservation checks. Продолжение исходных no-replay проверок после неизвестных ресурсов использует явно отмеченное **harness-only manual reconciliation**, не новую product auto-cleanup policy. Никаких skips/удаления assertions ради green.

Документация: новый `setup/docs/lock-cancel-r3.md`; датированные поправки operations, privileges, plan-context-r22. Dependencies/pins, CONTRACT1.0.0, public CLI/config/C13/state schemas, closed producer actions, exact target identity, TTL/gates, prepared/committed semantics не изменялись.

**Lock invariant:** все cooperating acquire/release/recover/cancel producers держат короткий mutex, полученный atomic mkdir `lock-protocol/`, до generation check и rename/remove. Замена generation внутри check/use окна исключена этим общим протоколом. Guard не автоматически reclaim-ится: crash/повреждение — manual blocker с evidence. Incomplete owner остаётся на месте. Recovery допускает только proven-dead плюс проверенные state/journal/absence-of-live-operation facts. Resolved journal не считается live. Boot change, PID reuse и resource-bearing deployment требуют reconciliation/manual action; отсутствующий reconciler не выдумывается. UUID quarantine не перезаписывается cooperating writers; rename/fsync failures имеют сохранённые source/quarantine/temporary outcomes.

**Cancel:** schema2 содержит full owner; unique owned temp → bounded write → fsync(file) → atomic rename → fsync(parent). Ошибка повторной публикации не повреждает accepted matching request. Consumer read-only: никогда не удаляет более новый запрос. Старый run не отменяет новую generation. Malformed/unsafe cancellation evidence блокирует continuation. Legacy unbound JSON не авторизует отмену и сохраняется. CLI требует ordinary owner; valid active run проверяется без acquisition обычного installation lock.

**Finite admission:** long policy/context work → bounded reseal → cancel observation → прежний metadata fence → synchronous TTL/gates → intent. Nonmatching-request await не открывает закрытое R221 окно. Cancel после checkpoint сохраняет exact receipt/checkpoint; resume не повторяет prefix. In-flight signal с неизвестным outcome/cleanup и release failure дают8, не130/143.

**Emergency:** ordinary owner проверяется до PAUSED/commands; ordinary installation lock не требуется. Только текущий reviewed deployment, подтверждённый S05 receipt/journal/config/archive/manifest/content, может dispatch confined installed Node. Runtime bytes сверяются с running executable identity; args не выбирают arbitrary binary/shell/traversal. cwd привязан release root. PAUSED durable и остаётся при stop failure. Status capability использует существующий app_status, без invented command; narrow postcondition schema описана в protocol doc. Service adapter unsupported. Inventory advisory; live query/inspect checks обязателен при Docker inventory. Malformed UUID/inspect, timeout/output limit/partial stop — unknown/nonzero, не benign foreign. E-sudo доказывал unsafe fake-adapter dispatch, не реальную root exploitation.

## Приёмка A3

Статусы относятся к локальному объёму. PASS не означает host/power-loss qualification.

| ID | Статус | Проверенное основание |
|---|---|---|
| A3-01 | PASS | Node24 original baseline14 complete,7 desired PASS/7 FAIL; baseline checker0, desired checker1; originals неизменны. |
| A3-02 | PASS | Active owner сохранён, proven-dead/no-live quarantined; invalid JSON/shape/oversize/fields/metadata/symlink/foreign identity отказаны. |
| A3-03 | PASS | EPERM/unknown ticks/stat/boot не dead; ESRCH positive, reuse/boot manual, comm spaces/parentheses и numeric bounds. |
| A3-04 | PASS | Actual owned-FS deterministic deferred barriers: competing recover/acquire7, first recovery0, stale release8, свежая nonce сохранена. |
| A3-05 | PASS local | mkdir/owner-write/fsync/rename before/after/parent-sync/guard failure evidence; unknown FS/resources/boot блокируют до takeover. Physical crash NOT RUN. |
| A3-06 | PASS | Repeated cancel write/ENOSPC/file-sync/rename/parent-sync faults сохраняют matching accepted bytes и consumption. |
| A3-07 | PASS | Serialized concurrent writers/generation swap; read-only consumer не удаляет запрос; stale/foreign run не отменяет новый. |
| A3-08 | PASS | Mapped early/admission cancel130, APT0/0/0, S02 events0; no-cancel0 и1/1/1. Hook hits обязательны. |
| A3-09 | PASS | Exact first receipt/checkpoint сохранён; явный resume завершает suffix без replay; S03 inherited controls. |
| A3-10 | PASS local | Failed release/in-flight130/143→8; безопасный pre-intent130/143 с подтверждённым release. Full tree supervisor — Q1B. |
| A3-11 | PASS local | Root/foreign cancel/recover/emergency3 до target writes/commands; injected ordinary-owner positive paths. |
| A3-12 | PASS local | Raw/sudo/shell/traversal/tamper/symlink/cwd/runtime-pin negatives commands0; genuine engine-published synthetic trusted stop/status positive с exact cwd. |
| A3-13 | PASS local | Emergency работает при held installation lock; missing/service capabilities честно blocked; PAUSED retained после failures. |
| A3-14 | PASS local | Known foreign UUID skipped; invalid IDs/labels/inspect, timeout/output limit, partial stop/postcondition failure nonzero. Fake daemon только contract. |
| A3-15 | PASS mapped | O01 recover8/repeat8/resume8 с fresh-review action, затем explicit review/resume0 без effects replay; original raw red сохранён. |
| A3-16 | PASS | Final single-run boundary14/context5/S03 13/genuine v1+v2 each13; exact ordered IDs, META/counts и product predicates проверены. |
| A3-17 | PASS mapped C01 | Suite589/589,74 новых R3 tests; frozen33 с одним объяснённым C01 outcome mapping, command37/R2-checker39 unchanged. Эти sets пересекаются и не суммируются. Original C01 oracle — known-red. |
| A3-18 | PARTIAL provenance | Exact final sources/hash/reconstruction проверяются отдельно; после полного capture owner index сохранён. Bytes раннего index/unstaged split до внешнего события отсутствуют, это не объявляется PASS. |

## Фактические проверки и attempts

1. Immutable134ecd directory archive baseline: npm ci/build; original R3 collector14/META complete; separate stdout/stderr/exit/signal/duration. Node26 measurement retained, затем corrected Node24 measurement: 14/7/7, baseline0/desired1. Это deliberate red, не unexpected runtime failure.
2. Development checks нашли fixture/API incompatibilities, unsafe old no-active-run cancel assumptions и один слишком ранний state snapshot в новом fence test. Сохранены raw failures, причины и соответствующие source/harness changes. Два зависших собственных development runs завершены TERM только по установленным PID/parent identities; pre-existing чужой/старый run не трогался. В одном старом fixture assertion failure оставлял safe holder child; это не объявляется исправлением исторического O02.
3. Intended attempt1: полный suite **577/583**, six stale lock-only0 assertions failed. Все raw сохранены. Исправлены fixtures: product требует8 до quarantine, manual harness continuation явно отделён.
4. Targeted current affected tests **80/80**: R3 cases плюс шесть child barriers; обычный code path, no keepalive.
5. Intended attempt2 на final source bytes: suite **589/589**, boundary14/context5/S03 13; original genuine-v1 runner incomplete после1 case, typed `lock_filesystem_unsupported` от исторического FS API. Одна instrumented попытка первого incomplete runner: exit1, beforeExit1, active FS/child boundaries=[]; причина установлена как отсутствующий method. Добавлен отдельный bridge; targeted genuine-v113/13. Исходный runner/raw не редактировались.
6. Intended final attempt3: тот же source snapshot и новый полный run после harness correction; результаты заполняются только из его собственного ledger/checkers, без склейки с attempts1/2. Original O01 и frozen C01 exit0 expectations отдельно known-red. Final matrices используют явные mapped checkers только для перечисленных в MAPPING.md различий.

7. Packaging attempt1: `git apply --check`128 из-за временного `a/new/` prefix в header added file; apply не выполнялся. Сохранены raw/check/header и packaging script; исправлена только сборка путей patch, tested sources не менялись. Финальная reconstruction применяет исправленный payload один раз.

Команды: `npm --prefix setup ci --ignore-scripts --no-audit --no-fund`; `npm --prefix setup run typecheck --silent`; `npm --prefix setup run test --silent`; `validate-r3-inherited.py --repo ... --fixed ... --bundle ... --work ...`; original/mapped R3 collectors и checkers; exact final completion/source checks. Полные argv/cwd/PID/exits/signals/durations — в ledgers, stdout/stderr раздельно. Исторические revision archives создаются через git archive в ordinary directories, без веток/worktree/index.

Final run summary: **589/589**, fail/cancelled/skipped/todo=0; boundary14/14; context5/5; original S03 13/13; genuine v1→C13 и v2→C13 по13/13; mapped frozen33, command37, R2-checker39 PASS. Original O01/C01 expectations остаются known-red. Final original replay COMPLETE, instrumentation в этом final run=0, no splicing. Отдельная единственная предыдущая diagnostic attempt=1. R3 adapted14/14; checker negative completeness controls8/8; inherited completeness controls13/13. Final inherited checker и дополнительный R3 checker exit0; последний подтвердил74 exact ordered unique new test names,166 current source inputs = tested snapshot и104 unchanged runner/fixture inputs. Main tested-files manifest включает эти270 inputs; package/dependency integrity привязана к lock и ci, node_modules не упаковывается.

## R211-O01/O02 и открытые границы

O01: bytes recovery не даёт executable approval. Prepared/утраченный review требует fresh explicit plan/review/gates через существующий exit8/manual-action contract. Recovery не продлевает TTL и не создаёт review. Original automatic-resume expectation superseded under unchanged C03/C07/C09/C13; original oracle **не стал PASS**. Frozen C01 использует такой же отдельный mapped outcome; остальные comparisons не меняют expectations. Полный перечень old→new barriers и control predicates — `runners/MAPPING.md`.

O02: **historical runtime cause OPEN**. Финальный complete run не доказывает устранение причины прежних обрывов. Текущий incomplete genuine-v1 имеет установленную API-причину; instrumentation не изменяла loop lifetime/таймауты. Не было retry-until-green, склейки partial matrices или silent expectation downgrade.

NOT RUN: реальные sudo/APT/systemd/SSH/UFW/Docker daemon, OAuth/providers/model calls/credentials, VM/VPS, actual Ubuntu ordinary-owner/PAM login, physical crash/power loss, hostile OS/root FS writers, полный TERM/KILL process tree, M0/M1/M2 application qualification, service/unattended и production deployment. Boot/PID-reuse/resource reconciliation остаётся typed manual path; Q1B/Q2 не объявлены закрытыми.

## Пакет и handoff

Пять выдаваемых файлов: этот report; `audit/evidence/q1a-r3-2026-10-27-local/full-local.patch`; `tested-files.sha256`; `evidence.zip`; `evidence.zip.sha256`. README описывает named base, owner/agent layers, единственное применение full patch, точные hashes и исключения упаковки. Нет new-files.tar и двойного применения новых файлов. Transport не включает node_modules/dist/temp trees, старые ZIP или repository archive. Generated seal metadata не является executable reconstruction payload.

Ready for human local code review с указанным provenance limitation; не production approval. Единственное действие владельца: **передать пять файлов reviewer**. Коммиты, публикация и любые privileged/live/VPS действия — вне этого задания.
