# Q1A-R2.2.1 — 2026-10-27

**Общий статус: PARTIAL. Функциональные R221-F01/F02: PASS local.** Final admission и stale approval исправлены; финальная suite515/515 и новые independent boundaries14/14 проходят. Один original independent replay полностью завершился, однако историческая причина R211-O02 не установлена и стабильность runtime не объявляется исправленной. Production OPEN, real-host/privileged/VM/live qualification NOT RUN. Следующий пакет не начат.

## 1. Исходная точка и owner layer

Initial HEAD `ad84212831892d18ab4dbcaab0d1bfecdc103f1b`, tree `5ceab7c5de2838555f7a3eae12bd01f6c4635832`, branch master. Initial index SHA256 `b30701a29f1dd62b1f88c13c80a90f6c3c008e8bcd9d6b2e55b452405952fa6b`. Owner layer: staged+unstaged `audit/R221-copilot-prompt.md`, `audit/reviews/R22-audit.md`; staged `audit/evidence/R22-all-files.zip`. Первый read-only вывод фиксирует эти статусы и index hash; до полного snapshot произошёл внешний commit. Полные bytes/hashes/status/stage entries и staged/unstaged patch в `initial/` относятся уже к snapshot564bb057 (оба patch пусты). Раздельные staged/unstaged bytes из первого вывода не были полностью сняты до внешнего commit; не выдаются за сохранённый исходный index. Owner-layer.patch воспроизводит три audit input файла из внешнего commit относительно первого observed basead842128.

Между первым read-only выводом и полным pre-edit snapshot HEAD/index изменились **извне**: HEAD `564bb05736406db7bb8f930bf9a6a14195e8f73f`, tree `3912ceb6a012ab80efd4adf1aab85f799ab9c762`, commit subject `audit files`; index `6dfc768beb153b5e85126647d712065e8351c9e6010dde0dd0afc281c6a32b13`. Actor не установлен. Delta — только те же три owner audit-файла; их bytes совпадают с полным pre-edit snapshot после этого commit. Все157 исходных setup inputs в новом HEAD совпадают с ad842128; это проверено отдельно. Baseline archive и первая final reconstruction фактически созданы из564bb057. Packaging восстанавливается из первого observed ad842128 + явного audit owner layer + agent delta;158 tested source bytes совпадают с действительно проверенной копией. Агент не создавал этот commit и не отменял внешнее изменение. Сохранены оба состояния; final HEAD/index остаются в наблюдавшемся внешнем состоянии, не возвращаются принудительно к initial.

Агент не выполнял commits/push/branches/worktree/PR/merge/tag/release/deploy/staging/add-N/reset/clean/stash. Packaging использует файловое сравнение с ordinary archive base, **не index**. Никакие dependencies владельца не удалены: npm ci выполнялся только в отдельных копиях.

Работа началась26октября, упаковка завершена27октября Europe/Amsterdam; historical command paths с26октября сохранены без переписывания. Actual tested identity — **local bytes, нового tested commit нет**. Реконструкция: initial `ad842128…` + owner layer + agent delta. Tested manifest158 setup inputs: SHA256 `ea66c4cb45178ffd584e2b3680af3326543c4a0483cac6046c7d3a574ff8c428`. Manifest охватывает source/schema/tests/helpers/docs/config/locks/bootstrap/release inputs, исключает node_modules/dist/temp/Git metadata/secrets. Runner/fixture/report/package hashes — отдельно. До/после окончательной validation все158 hashes совпали.

Входной R2.2 ZIP проверен: `bcc9f3a25ae693d4922ed39d5e81755178d20874dfd6d7341fbcbb30941a030e`. Reviewer outer `R22-all-files.zip`: `fcb554f3d7715095aea204513b5402f1bc85b0989ef00708daed10a1b1e397d4`; inner `R22-evidence.zip`: `a318ad13cb400ef156424a5069efd68606a1ba815cb82506f03bbb1d6cc6b00c`. Вложение распаковано вне source tree с проверкой path traversal, symlink/type и size bounds; исходные runners/oracles/исторические incomplete attempts сохранены неизменными.

## 2. Meaningful baseline → fixed

Baseline — ordinary archive **564bb057** (audit-only descendantad842128 с побайтно одинаковым setup), собранный на настоящем Node24.12.0. Реальные engine/S02/S05 и filesystem; external APT/release effects и identity injected. Никаких настоящих host mutations.

| Случай | Baseline | Fixed |
|---|---|---|
| S02 config/plan newline во время final context read | exit8, но refresh1, simulate/install0; checkpoint создан | exit8, counts0/0/0, ни одного S02 intent/effect/verify/checkpoint |
| S05 lock pin/config/plan swap во время final archive hash | exit8, но extract1 | typed refusal, extract/materialize/probes0/0/0, ни одного target intent |
| Gate config/plan/lock swap во время policy probe | exit0 и approved, evidence изменяется | nonzero, approval не записан, evidence hashes неизменны |
| S02 fault-off | exit0,1/1/1 | exit0,1/1/1 |
| S05 fault-off | exit0, extract2/materialize1/probes3 | то же; два extract относятся к двум отдельным staging operations |

Original desired oracle: **14 complete /6 PASS /8 FAIL**, exit1; observed-current exit0 означает только точное воспроизведение дефектов. Fixed desired: **14/14**, exit0. Baseline logs — `baseline/`; fixed — `logs/boundaries/*`, `logs/boundary-desired.stdout`. Newline проверяет frozen bytes, не выдаётся за исполнение чужой команды. Lock pin swap содержательный.

Original context runner не изменён. Для release runner отдельный `release-boundary-final-admission.cjs` выбирает первый hash в `finalPlanAdmission` вместо устаревшего ordinal5; после сокращения captures пятый hash уже не является исходной границей. Stack/hit подтверждают момент изменения после настоящего archive hashing перед первым effect. Case IDs/counters/product oracle не изменены. Оригинал сохранён byte-for-byte; несработавший hook никогда не считается безопасным отказом.

## 3. Исправление и граница доказательства

Production diff ограничен **двумя файлами**:

- `setup/src/core/engine.ts`: единый `finalPlanAdmission` для effect/apply/resume и approval; reseal при plan publication; applying публикуется только вместе с допущенным in-flight operation; approval больше не сохраняется в finally.
- `setup/src/core/plan-context.ts`: typed per-admission file witnesses и bounded revalidation. Это внутренние неперсистентные значения, не новый authorization store/cache, не изменение C13/state/schema.

Также добавлены `q1a-r221-final-admission.test.ts` (30 tests), дополнен `setup/docs/plan-context-r22.md`, созданы evidence tools/docs. Package pins/dependencies/application/S03/S04/S05 producer behavior не менялись.

Invariant финального допуска: trusted exact producer/closure + reviewed plan/context + current frontier + frozen request + TTL/gates согласованы на одной конечной границе после дорогих чтений. Порядок:

1. Ordinary owner и точный producer policy; текущие policy probes.
2. Context capture с проверенным actual archive hash и первоначальными bounded lock bytes.
3. Повторная проверка current policy frontier после hashing.
4. Повторное чтение/валидация bounded lock bytes и host/owner/session facts.
5. Frozen config/plan bytes и заключительный metadata fence всех captured files.
6. Синхронные TTL/gates; только затем intent/in-flight/effect либо approval.

Witness связывает path и dev/inode/size/mtime/ctime/mode/UID/GID/nlink/type. Он проверяется после всех длительных probes/content reads; ancestors/type/ownership/symlink rules сохраняются. Lock reread ≤1MiB; archive не хешируется второй раз ради reseal, но его identity/path metadata должны остаться неизменны. Нет бесконечного «читать до стабильности». Проверенные bytes служат источником сравнения; execution не подхватывает новый plan из пути и не выполняет plan fields как shell.

Plan generation повторно проверяет frontier после final hash и seal перед prepared publication, затем seal exact serialized producer plan/config/context перед committed publication. При позднем изменении prepared остаётся неавторизующим. Уже подтверждённый progress сохраняет исходные attempts/receipts/checkpoints; explicit fresh review продолжает remaining suffix без replay.

Approval refusal не сохраняет approved из finally. Сохранено прежнее **явное expiry invalidation**: если plan уже истёк при входе в command, весь context/request/policy fence всё же проходит, можно записать только expired statuses с прежними identity/expiry/progress. Expiry, достигнутое во время probes, или любой context failure не публикуют state. Это покрыто новыми negatives и прежними A05/A21-13; срок не продлевается.

Остаток OS TOCTOU честно ограничен: fence не является атомарным filesystem snapshot. Writer может гоняться с отдельными metadata syscalls или изменить файл после последнего fence. Это не квалификация root-safe writes/privileged filesystem/process isolation Q2/Q1B. Известные unsafe/missing/symlink/invalid/truncated inputs остаются fail-closed.

## 4. Acceptance mapping

Ссылки ниже относительно `audit/evidence/q1a-r2-2-1-2026-10-27-local/`. Полные имена assertions/counters — в raw logs и source test, машинная матрица — acceptance.json.

| ID | Status | Конкретное доказательство |
|---|---|---|
| A221-01 | PASS local | Original baseline14 cases/6 desired; fixed14/14; checker IDs/META/hits1; baseline/fixed logs |
| A221-02 | PASS | Настоящий S02 apply и fresh-engine resume, config/plan swap на final version-lock read; counters0, target journal пуст, stage не false applying; fault-off1/1/1 |
| A221-03 | PASS | Настоящий S05, actual hash barrier; lock pin/config/plan/archive/manifest negatives; extraction/materialization/probes0; fault-off2/1/3 |
| A221-04 | PASS | Approve policy/hash drift config/plan/lock/archive/manifest/session/TTL: durable approval отсутствует, evidence unchanged; unchanged session/control approves |
| A221-05 | PASS | Plan final context hash swap и request swap при plan rename: refusal, prepared не committed; positive counterparts; exact produced plan bytes sealed |
| A221-06 | PASS | Apply/resume common final helper; explicit synthetic gate-free producer тоже получает refusal до owned counter effect |
| A221-07 | PASS | New session после confirmed refresh: checkpoint/no in-flight сохранён, old resume4, fresh review продолжает1/1/1 без replay; прежние late TTL/lock drift controls сохранены |
| A221-08 | PASS | Context5/5; original S0313/13; genuine v1 и v2→C13 explicit review13/13 каждый; один законченный original replay |
| A221-09 | PASS local | Все485 прежних смысловых assertions сохранены, final515/515; schema/TTL/target/producer/state/crash/S05 command identity guards и composition; frozen33/command37/R2checker39 |
| A221-10 | PASS harness | Exact IDs/order/unique/count/META/exit/signal contract, product oracles и final predicates; 13 deterministic harness controls, включая early exit/unsettled/empty/partial/duplicate/bad count/product failure; incomplete не PASS |
| A221-11 | PASS limitation preserved | Original final recovery desired runner exit1; measurements recover0/repeat0/resume8, explicit review resume0, unchanged S03 counts/checkpoint. O01 остаётся R3 |
| A221-12 | PASS | Initial base+owner+agent patches фактически восстановлены;158 source hashes и runner/payload hashes проверены; index для packaging не использован; timing gap первого index snapshot явно раскрыт |

## 5. Фактическая validation и O02

В обычной reconstruction `/private/tmp/af-r221/final-tree`:

| Command | Result |
|---|---|
| node --version | exit0, v24.12.0 |
| npm --version | exit0, 11.6.2 |
| npm --prefix setup ci --ignore-scripts --no-audit --no-fund | exit0 |
| npm --prefix setup run typecheck --silent | exit0 |
| npm --prefix setup run test --silent | exit0, **515 passed /0 failed /0 skipped**,96258.900333ms |

Actual macOS15.5 arm64, UID501; target/owner explicitly injected Ubuntu24.04 amd64 /UID1000 (historical migration retains its original fixture architecture). Реальный Linux/PAM/ordinary-owner deployment не квалифицирован. Только безопасные owned children/temp files; sudo/APT/systemd/SSH/UFW/Docker daemon/provider/credential/deployment calls не выполнялись.

`logs/commands.json` содержит argv/cwd/env allowlist/PID/elapsed/exit/signal и отдельные stdout/stderr. Все обязательные матрицы получены в **одном original replay**, без splicing и без повторов до green. Context5/5, S0313/13, genuine v1/v2 migration13/13, frozen33, command37, R2checker39 прошли. Эти overlapping counts **не суммируются**. Raw exit0 проверяется отдельно от completeness и product acceptance. Exact IDs были проверены при collection; strengthened final predicate checker повторно проверил только сохранённые outputs, без запуска новых product attempts.

**R211-O02: OPEN, причина NOT ESTABLISHED.** В разрешённом одном original replay incomplete не воспроизведён. Поэтому first-incomplete=null и targeted instrumented attempts=0; не создавался искусственный повод для tracing или повторов. `diagnostic.cjs` готов для одного первого incomplete в воспроизведении: bounded async FS/child begin/end, beforeExit/exit, PID/hrtime/last active work; он не создаёт keepalive и не объявляется runtime fix. Таймауты не увеличивались. Исторические reviewer и R2.2 incomplete raw attempts сохранены отдельно; нынешний законченный run не доказывает их причину/устранение.

Completion enforcement исправляет достоверность заявления о PASS, но не неизвестный runtime defect: `checked-runner.cjs` делает early exit0/unsettled main без полного контракта exit70; parent completion checker отвергает wrong/duplicate IDs, missing marker/count, exit/signal и failing product predicates. Для originals без META — exact terminal-row completion contract плюс исходные product assertions. Product aggregates не запускаются, если матрица incomplete; частичные27 не превращаются в frozen33. Historical baselines допускают только их явно заданный observed-unsafe oracle, не fixed PASS.

Промежуточный полный прогон513/515 выявил два expiry-status assertions, они сохранены и исправлены production invalidation path, не удалены. Первый native fixture имел неверное gate ID; corrected fixture использует реальный producer gate. Все промежуточные logs классифицированы в intermediate, не выдаются за final validation.

## 6. Handoff

Общий PARTIAL сохраняется из-за недоказанной причины/устойчивости R211-O02; отдельно раскрыт timing gap полного snapshot начального index до внешнего audit commit; функциональные F01/F02 готовы для независимого review. R211-O01/R3, Q1B/Q2–Q6, настоящий S03 sudo/SSH/timer code blocker, M0/service/live, AF backlog и production остаются OPEN. Real-host/privileged/VM/live checks NOT RUN.

Передать владельцу локальные report, full-local.patch, owner-layer.patch, agent-delta.patch, new-files payload/manifest, identity.json, tested-files.sha256, evidence.zip и внешний checksum. Initial base+full patch восстанавливают owner layer и agent changes; payload не применяется повторно. Report/patch/manifest внутри ZIP и рядом совпадают по bytes. Поскольку агент ничего не публиковал, ссылка на master не заменяет эти local bytes.

Следующий шаг — независимое review, затем остановка. **Никаких commits/push/новых веток/worktree/PR/merge/tag/release/deploy/staging/index packaging в последующих генерируемых промптах.** R3 требует отдельного задания.
