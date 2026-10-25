# Q1A-R1.6 — S05 checked entry → executed entry

2026-10-25, Europe/Amsterdam. **R1.6 local scope PASS; production OPEN; real-host qualification NOT RUN.** R15-F01 исправлен в ограниченном scope. Q1A, AF-05/06, AF-08/09/31 и общий AF backlog не объявляются закрытыми. Коммиты/push/ветки/worktree/PR/merge/tag/release/deploy агентом не выполнялись; index для packaging не использовался.

## База и ownership

Фактический initial HEAD: `420e5456d3e05b1c4f9b7202cacebb82baaf61eb`; tree `2dd3d1a1557e9687482b308eff16c0a0da399cd2`; branch `master`. Read-only status пуст, staged/unstaged/untracked owner layer **пустой**. Начальный SHA-256 `.git/index`: `fe15a533b203cd4d00b71aedfea1b287367d842745ae22615e1c0613e2c4cab6`. Snapshot, пустые initial diffs и итоговое сравнение входят в evidence.

От проверенного master `b888082167b5edc50977a6dcda997b40e962da8d` отличаются только четыре committed audit-входа: `audit/copilot-r16-task.ru.md`, `audit/evidence/agent-factory-r15-review-evidence-b888082.zip`, его `.sha256`, `audit/reviews/agent-factory-r15-audit-b888082.ru.md`. Их hashes сохранены в `base-delta.json`. Production baseline не менялся; все 135 файлов R1.5 manifest (`2d70f17d321a92acdabe9baa832e30adeab63b3ec9b6fc93b4481d06e8941f01`) совпали с base archive. Замечание применимо.

Прочитаны root `AGENTS.md`, audit R1.5, текущий R1.5 report, CONTRACT 1.0.0, application-release docs, execution-plan и соответствующие source/tests. Запрошенного `../AGENTS.md` на диске нет; использован repository `AGENTS.md` и инструкции владельца. Нормативного конфликта не выявлено: C10 требует absolute trusted argv/shell=false; C13 связывает команды с release и установленным Node pin. Новая public schema/contract version не требуется. Runtime flags до entry документацией application-release не требовались; поддержки arbitrary loaders/eval не добавлено.

## Дефект, исправление и production diff

R15-F01: validator связывал `argv[1]` с content hash, но execution делал entry абсолютным только по отдельным suffix. `.cjs`/extensionless запускались из CWD; hashed filename `--eval` превращался в Node option. Это детерминированная identity ошибка, не TOCTOU.

**Единственный production-файл:** `setup/src/adapters/git.ts`. Удалены раздельные `resolveBinary`, `resolveCommandArgs`, `supportsCommand`. Общий `prepareOfflineCommands` используется и `assertOfflineCommands` (stage admission), и `probeCommands`. Он заранее подготавливает оба required command keys и возвращает явно представленные immutable commands: kind, contentEntry, absolute executable, exact final argv. Фактический spawn использует именно эту подготовку.

Grammar:

- `node` либо точный `paths.setup_node_dir/bin/node`; затем обязательный canonical relative file, затем application args. Никаких Node runtime options до entry. Entry с ведущим `-`, включая `-`, `--`, `--eval=…`, отвергается exit 9 `s05_command_content_unbound` даже с hashed file.
- Entry обязан быть content-map key; absolute/traversal/backslash/NUL/empty/dot segments запрещены. Node entry всегда абсолютный внутри deployment независимо от suffix. `.js/.mjs/.cjs/.ts` и extensionless сохраняют работоспособность. Nested `bin/-runner.cjs` безопасен, потому что Node получает абсолютный путь.
- Node executable — ранее выбранный installed pin, он не переносится в application content map. Direct relative executable, например `bin/check`, сам обязан быть hashed content entry; исполняется его абсолютный deployment path без PATH search/external shell/sudo/env обхода.
- Application arguments после entry не переписываются: порядок, spaces, quotes, `--eval`, относительный `.js` аргумент сохраняются. В конец добавляется один `--help`. Node delimiter не добавлен: абсолютный file entry первым аргументом уже отделяет application args; это проверено настоящим Node 24.
- Оба command keys валидируются до первого child. Перед **каждым** help сохранены настоящие current metadata/content checks. Между help-пробами drift блокирует вторую, без общего успешного результата. Missing command — exit 5; invalid/security argv — exit 9; false/timeout — прежний failure exit 5; unexpected probe throw — прежний exit 6.

`stages/application.ts`, ProcessAdapter, core/state, S03/S04, application/M0, schemas/locks/contract не менялись. Дополнительного production scope нет. Prepared argv не устанавливает глобальный CWD. В тестах CWD задаётся при fork отдельного owned worker; production NodeProcessAdapter остаётся настоящим и без изменения cwd API.

Остальные файлы: `setup/tests/integration/q1a-r16-commands.test.ts`, `helpers/r16-commands.ts`, `helpers/r16-command-child.cjs`, `setup/docs/application-release.md`, этот report и local evidence. Старые 364 tests не удалялись и не переименовывались.

## Baseline и red evidence

Исходный `command-identity-probes.cjs` сохранён без изменения oracle. Одинаковые исходные fixtures запускались на base и reconstructed fixed, отдельно `adapter` и `stage`. Stage mode имеет synthetic archive/checkout/receipt; реальные hashes, argv и Node child. Он **не** считается полной engine/archive qualification.

| Case | Baseline, оба режима | Fixed, оба режима |
|---|---|---|
| W01 `.js` | 2 calls, `REVIEWED_ENTRY`, success / verified | 2 calls, тот же checked absolute entry, success / verified |
| W02 `.cjs` | 2 calls, `UNREVIEWED_CWD_ENTRY`, ложный success / verified | 2 calls, absolute hashed path, `REVIEWED_ENTRY`, decoy не запущен |
| W03 extensionless | 2 calls, `UNREVIEWED_CWD_ENTRY`, ложный success / verified | 2 calls, absolute hashed path, `REVIEWED_ENTRY`, decoy не запущен |
| W04 hashed `--eval` | 2 calls, `UNBOUND_OPTION_EVAL`, ложный success / verified | typed `s05_command_content_unbound`, executable calls=0, result=null, verified не опубликован |

Все восемь исходных fixtures schema-valid. Baseline: 1/4 безопасных исходов в каждом режиме; fixed: 4/4. `harness_ok` и exit 0 не считались product PASS. Полные hashed path, actual binary/argv/CWD/stdout/exit и schema result — `logs/baseline-*-final.jsonl`, `logs/fixed-*-final.jsonl`; machine assertions проверены отдельно `check-r16.py`.

До production edits добавлены первые три regression tests: absolute `.cjs`, absolute extensionless, hashed eval refusal. Test/helper layer отдельно наложен на base: build exit 0; tests exit 1, **0 passed / 3 failed** по правильным assertions. `red-layer/`, `red-commands.json`, `red-tests.log` сохранены. В red tests опасные argv перехвачены, не исполняются. Реальное безопасное stdout-only eval в baseline запускалось только исходным разрешённым audit harness.

Промежуточные expanded fixture ошибки сохранены: macOS `/var` ↔ `/private/var` CWD alias, отсутствие executable bit у добавленного direct fixture и schema-invalid пустой application arg. Исправлены только fixtures (realpath caller, mode700 для собственного shebang file, schema-valid args). Они не считаются продуктовым red или acceptance. Поздние расширенные tests не выдаются за выполненные до fix.

## R15-F01 → W01…W12

Все PASS ниже ограничены local scope. `acceptance-matrix.json` содержит полные test names, source и log; `real-commands.json` — реальные argv/CWD/stdout; `grammar-refusals.json` — typed zero-child controls. Assertion names приведены в итоговом `logs/final-validation/tests.log`.

| ID | Конкретное evidence / assertion | Status |
|---|---|---|
| W01 | `W01 real Node checked …`: `.js/.mjs/.ts` × short/exact pinned; настоящий NodeProcessAdapter в owned child, schema=true, оба help реально exit0, stdout reviewed, actual args[0]=hashed absolute entry | PASS |
| W02 | `W02 real Node cjs CWD decoy never runs …`, оба binary forms; дополнительно исходный adapter/stage harness; decoy marker отсутствует, правильный entry реально выполняется | PASS |
| W03 | `W03 real Node extensionless …`: отдельный CWD с decoy и без него; обе help успешны, checked marker и absolute entry | PASS |
| W04 | `W04 hashed --eval …`, baseline/fixed adapter/stage logs: исходная expression+`--` после fix даёт security refusal и 0 child; stage не verified | PASS |
| W05 | `W05 every option-shaped entry …` для обоих keys: 12 явно перечисленных filename variants, включая -e/-p/eval/print/require/import/inspect/input-type/env-file/-/--; hashed файлы настоящие; schema=true, exit9, 0 executable calls. Опасные children не запускаются | PASS |
| W06 | `W06 grammar …`, `W06 bound entry metadata …`: missing/unlisted/absolute/traversal/double-segment/dot/backslash/NUL/external/sudo/shell; missing file, symlink, unsafe mode/owner/special file — refusal до child; metadata owner/special моделируются injected FS, а не privileged chown/mknod | PASS |
| W07 | `W07 real Node nested dash filename …` и `W07 prepared identity …`: nested dash file, spaces/quotes/--eval/--require/relative.js/-- в application args; сохранены реальные boundaries и order, frozen prepared representation | PASS |
| W08 | `W08 bytes drift after first help …`: actual hash/content adapter; после первой подтверждённой invocation файл меняется, вторая не вызвана, exit9 без общего PASS | PASS |
| W09 | `W09 real S05 engine-created evidence …`: actual processes + CWD decoy, полный plan/apply/plan/verify/status-refresh/apply/resume, plain status без записи/probes. `W09 engine-bound invalid …` для обоих keys: настоящие engine materialization checkpoint receipts, реальный grammar/hash/probe adapter; stage observe/verify с captured engine context отказывают; нет probe verify/checkpoint/new verified/downstream | PASS |
| W10 | `W10 real confined native …` direct и mixed Node/direct; собственный stdout-only shebang executable, actual requested binary=deployment content entry; native relative.js/--eval/spaces args не переписываются | PASS |
| W11 | `W11 real S05 producer preserves typed …`: false/timeout →5 с 2 actual intercepted calls, throw →6 с 1 boundary entry, missing →5 с 0. Repeat verify и no-trust/config/release/archive/path evidence guards также сохранены в исходных U02/V03 tests полного suite | PASS |
| W12 | Полный suite 397/397, включая все прежние 364; прежние frozen comparisons/C01…C12 и 33 assertions; real S00…S07 composition; проверенная reconstruction и 138-file manifest до/после tests | PASS |

Invalid engine lifecycle намеренно не чинит recovery protocol: после grammar refusal внутри уже admitted probe operation core консервативно сохраняет failed/unknown in-flight и последующие lifecycle commands блокируются. В tests это nonzero (как правило journal exit8), без replay/ложного proof. Прямые observe/verify с уже engine-generated trusted materialization context отдельно доказывают typed exit9. Никаких synthetic matching receipts для этого теста вручную не создавалось. Initial untrusted plan может подготовить reviewed plan, но executable authorization из marker не получает.

**Correction note к R1.5:** V03 в историческом report был чрезмерно отмечен PASS. Независимый аудит правильно установил **PARTIAL из-за R15-F01**; этот вывод не переписывается задним числом. Новые W01…W12 закрывают воспроизведённый deterministic command-identity gap локально. Это не общий сертификат безопасности всех команд, M0/service или OS races. R11/R12/R13/K/T/U/V IDs не переименованы; их прежние смыслы и ограничения сохраняются.

## Фактическая validation и identity

Реальный runtime: **Node v24.12.0, npm 11.6.2, macOS 15.5 arm64, UID 501**. Это обычный локальный пользователь, не root-installer qualification. `process.versions` не подменялся. Runtime отличается от независимой Linux/Node v24.22.1 среды аудитора; major24 соблюдён. Package ci выполнялся только в собственных временных copies.

Все команды ниже выполнены на свежей копии `/private/tmp/af-r16/fixed`, восстановленной через actual base archive + полный adding patch без index, после окончательных source/test/doc edits:

| Command | Exit | Log |
|---|---|---|
| `node --version` | 0 | final-validation/node.log |
| `npm --version` | 0 | final-validation/npm.log |
| `npm --prefix setup ci --ignore-scripts --no-audit --no-fund` | 0 | final-validation/ci.log |
| `npm --prefix setup run typecheck --silent` | 0 | final-validation/typecheck.log |
| `npm --prefix setup run test --silent` | 0 | **397 passed / 0 failed / 0 skipped**, final-validation/tests.log |

Exact argv/cwd/elapsed/exit — `final-validation/commands.json`, `audit-harness-commands.json`, `frozen-comparisons/independent-commands.json`. Frozen runner commands завершились 0; отдельно проверены все **33 product assertions**, а не только harness completion. Composition S00…S07 apply/status/resume=0, APT install=1, Docker install/probe=1, access cutover=1, application probes=7, image build=1, все external effects fake. Старые fault/crash cases полностью входят в итоговый suite; их final machine matrices приложены без повторной бесконечной suite.

Tested identity: **нового commit нет**. Base `420e5456…` + local patch; manifest **138 файлов**, SHA-256 `a95c623dde5996cf6abf4f93d9b03e76fdaef9fe0fc5ca6b6ced11fe0a9de5cb`. Перед и после tests SHA каждого source/test/config/schema/lock/bootstrap/release/fixture/setup-doc файла совпал с current workspace и reconstructed copy. Deletions=[]; excludes: dependencies/dist/Git metadata, audit/report/packaging и временные runtime artifacts; секреты не читались и не включались. Report сформирован после code validation, отдельный packaging layer с собственным hash; self-reference отсутствует.

## Выдаваемый пакет и remaining risks

Папка `audit/evidence/q1a-r1-6-2026-10-25-local/`: report, identity, полный patch с additions, new-files.tar/json, deletions.json, tested-files.sha256, evidence.zip и внешний checksum. Новые файлы уже входят в patch; tar — отдельный альтернативный payload, не применять повторно. ZIP содержит неизменённый audit runner, старые frozen runners/fixtures и checkers, red test layer, actual final logs/counters/argv, acceptance matrix, reconstruction scripts и внутренний SHA256SUMS. Дополнительная личная session directory или неопубликованный внешний архив не нужны. Report/patch в папке и внутри ZIP сверены по bytes.

Финальный adding patch с report повторно применён в пустой temporary copy; manifest/new-file hashes/deletions проверены. Initial HEAD/branch и index bytes сохранены (`final-repository-state.json`); owner layer был пуст и не потерян. Ни commit, push, новая ветка/worktree, PR, tag/release, deploy или следующий пакет не создавались.

**OPEN вне R1.6:** OS-level hash/exec TOCTOU, process-tree supervisor/Q1B и privileged executor/Q2, пустой actual NodeAccessAdapter cutover и marker-only timer/rollback; M0/service/unattended и production qualification. SSH Include policy B и Docker session/unknown-workload/recovery guards сохранены, не объявлены реальными host tests.

**NOT RUN:** VM/VPS/provisioning, sudo/apt/systemd/SSH/UFW/Docker daemon/cgroups, OAuth/credentials/provider/model/GitHub writes, host deployment/release и physical power loss. Новые реальные processes — только собственные local stdout/argv fixtures; inspector/preload/import negatives не исполнялись. Для review не нужны credentials, sudo, VPS или публикация.

Единственное следующее действие владельца — передать локальные report/patch/new-file payload/identity/manifest/ZIP/checksum на review. На GitHub этих локальных правок нет; одной ссылки на master недостаточно. Будущие пакеты — отдельные задания, с тем же запретом агенту на commits/push/branches/PR без нового явного разрешения владельца.
