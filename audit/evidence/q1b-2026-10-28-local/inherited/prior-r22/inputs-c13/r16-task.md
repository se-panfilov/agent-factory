# Copilot — Q1A-R1.6: точная привязка S05 command к проверенному executable entry

## Задача и обязательный режим работы

Выполни **только этот пакет R1.6**. Исправь R15-F01 из `agent-factory-r15-audit-b888082.ru.md`: S05 проверяет одни bytes, но может запускать другой файл из CWD или интерпретировать hashed filename как опцию Node. Подготовь исправленный локальный код, регрессионные тесты, отчёт и самодостаточный evidence bundle. Общая production readiness этим пакетом не закрывается.

**Не делай коммиты. Не пушь. Не создавай ветки, worktree с новой веткой, PR, merge, tag или release. Не выполняй deploy. Не используй git index для packaging (`git add`, `git add -N` и т. п.). Всё должно остаться локально.** Пользователь сам решает, когда публиковать изменения. Повторяй этот запрет в любом создаваемом следующем промпте для ИИ-агента.

Не сбрасывай, не чисти, не прячь в stash и не перезаписывай чужие изменения. Начни с read-only HEAD/branch/status/diff; сохрани initial staged/unstaged/new-file inventory и checksum index, если он существует. Если рабочее дерево уже изменено, отдели входной owner layer от своих правок и сохрани обе части в evidence. Не требуй чистого дерева ценой удаления работы пользователя. Не проси разрешение на обычные локальные обратимые действия в рамках этой задачи.

Прочитай `AGENTS.md`, этот аудит, текущий R1.5 report, `docs/automation/CONTRACT.md`, релевантные части application-release docs и существующие тесты. Явный пользовательский запрет на commits/push/branches/PR имеет приоритет над общими PR-шагами в документации. Если выявлен реальный конфликт неизменяемого публичного контракта, зафиксируй его с точными ссылками и изолируй конфликтующую часть; не ослабляй security contract ради зелёного теста.

## 1. База и сохранённые результаты

Проверенная база:

- master `b888082167b5edc50977a6dcda997b40e962da8d`, tree `9ed7b7e09eed8e80e099dc38578a9265ef634963`;
- R1.5 local base `d7d141106aa50f58c8ec9ac7c3991b4d9b42e6e6` + full patch SHA-256 `4d79264ffe10e7c58855d62a14f0feda2d95687593aeb9438cd7ec3a47608cb4`;
- tested-files manifest SHA-256 `2d70f17d321a92acdabe9baa832e30adeab63b3ec9b6fc93b4481d06e8941f01`, 135 файлов совпали с master;
- независимо: Node v24.22.1, typecheck PASS, **364 tests PASS**, 33 comparison assertions PASS;
- R14-F01/F02/F03 закрыты для исходных контрпримеров; V03 шире этих контрпримеров остаётся PARTIAL из-за R15-F01.

Если текущий HEAD отличается, покажи delta относительно `b888082` и установи, менялся ли релевантный код. Audit-файлы сами по себе не меняют production baseline. Не подменяй фактическую базу заранее заданным SHA и не объявляй fixtures неактуальными без проверки.

Сохрани R1.5: zero executable calls при known integrity mismatch; привязку materialization receipt к config/archive/commit/path/manifest; Docker install → group → durable pause → fresh approvals → config/restart/probe; unknown workload fail-closed; policy B для SSH Include; core recovery/receipt/journal/manifest/crash guards. Не переписывай core/state, публичные schemas и application/M0 для решения R15-F01.

## 2. Дефект, который требуется устранить

В `setup/src/adapters/git.ts` `assertOfflineCommands` считает Node entry равным `argv[1]`, проверяет canonical relative path и ключ в `content_hashes`. Затем `resolveCommandArgs` делает абсолютным только `.js/.mjs/.ts`, а настоящий `NodeProcessAdapter` не задаёт `cwd`.

Отсюда:

1. `['node', 'runner.cjs']` хеширует `<deployment>/runner.cjs`, но запускает `runner.cjs` из CWD. То же для extensionless `runner`.
2. `['node', '--eval', 'process.stdout.write("UNBOUND_OPTION_EVAL\\n")', '--']` принимается при наличии hashed файла `--eval`. Node выполняет inline code, не этот файл. Дописанный `--help` не предотвращает eval.

Все manifests в воспроизведении проходят настоящую application-manifest schema. Настоящие adapter и ProcessAdapter возвращают обе help-пробы true; настоящий S05 observe с согласованными synthetic archive/receipt возвращает `verified`. Это детерминированное расхождение admission/execution; TOCTOU для него не нужен.

Вложенный `evidence/command-identity-probes.cjs` содержит режимы `adapter` и `stage`. В `stage` synthetic только archive/checkout observations и receipt; actual hash checks, argv preparation и Node process остаются настоящими. Не представляй этот harness как полный engine/archive qualification.

## 3. Требования к реализации

### 3.1 Единая подготовка команды

Устрани расхождение между тем, что проверяет validator, и тем, что исполняет adapter. Используй один источник правил и один явно представленный prepared command: kind, content entry, absolute executable, фактический argv. Не обязательно вводить именно такие имена или публичный тип, но связь должна быть проверяемой в коде и тестах.

- Для Node допускай `node` и точный текущий pinned Node path согласно существующей политике. Определи строгую grammar manifest argv, где entry является именно file entry.
- Entry должен быть непустым canonical относительным путём внутри deployment, присутствовать в `content_hashes` и пройти существующие metadata/content checks. Absolute/traversal/backslash/NUL/пустые сегменты/`.`/`..`, symlink и неподдержанные типы не обходят проверки.
- Получай абсолютный путь entry в deployment **независимо от расширения**. Поддержи `.js`, `.mjs`, `.cjs`, `.ts` и extensionless обычный файл. Для `.ts` используй совместимый с текущим Node 24 harmless fixture; не расширяй здесь M0 contract. Не оставляй suffix fallback, который вновь может передать относительный entry.
- Ведущий `-` в Node entry, одиночный `-`, `--` на месте entry и другие option-shaped forms отклоняй до executable child даже при наличии соответствующего hashed файла. Наличие ключа content map не делает Node flag безопасным file entry.
- Минимальная рекомендуемая политика этого пакета — **без Node runtime options из manifest перед entry**. Не добавляй поддержку arbitrary `--eval`, `--print`, `--require`, `--import`, loaders, inspector, input/env-file options. Если уже существующая документация требует конкретный runtime flag, зафиксируй конфликт/совместимость; не принимай все flags ради одного M0 примера и не объявляй M0 qualification пройденной.
- Аргументы **после корректного file entry** являются аргументами приложения. Сохрани их значения, порядок и границы; строка `--eval` после entry сама по себе не должна превращаться в Node option или приводить к глобальному запрету всех application flags. Если добавляешь Node delimiter `--`, placement должен соответствовать фактической Node CLI semantics и быть проверен реальным процессом.
- Добавляй требуемый `--help` предсказуемо. Существующий fail-closed результат false/timeout/missing command не превращай в success.
- Для разрешённого relative executable вроде `bin/check` проверь его собственный content key и запускай его абсолютный deployment path. Не применяй Node-specific переписывание к произвольным аргументам native executable. Не разрешай PATH search, arbitrary external binary, shell, sudo или /usr/bin/env как обход pinned execution.
- Точный pinned Node path сам по себе относится к ранее выбранному runtime; не требуй записывать внешний pinned binary в application content map. Content map связывается с Node entry.

Не исправляй только `.cjs` или только строку `--eval`. Не используй shell quoting вместо argv-array. Не меняй глобальный CWD процесса setup: это создаёт race между параллельными операциями. Одного `cwd` в mock недостаточно. Если понадобится расширить ProcessAdapter `cwd`, реализуй и проверь настоящее поведение и объясни необходимость; абсолютный entry должен оставаться обязательным. Полный rewrite ProcessAdapter/supervisor вне этого пакета.

### 3.2 Сохранить admission и результат stages

Проверка обязательна для обеих команд `runner_verify` и `runner_stop` и для всех entry points, вызывающих probes. Сохрани последовательность reviewed release/config → bound receipt → допустимая command → актуальные bytes/metadata → bounded invocation. Сохрани проверку content перед каждой командой: если bytes меняются между verify-help и stop-help, вторая команда не исполняется.

Rejected command должна давать typed security refusal в рамках существующего exit-code контракта, до опасного child. При отказе не создаются успешные probe receipt/checkpoint/new verified и не запускаются downstream effects. `plan`/`status --refresh` не должны исполнять неподтверждённый entry. Plain status остаётся read-only без probes. Для корректного release обязательные probes действительно выполняются; запретить все команды — не решение.

Не имитируй journal receipts напрямую в единственном integration test: используй engine-created evidence для lifecycle tests. Разрешены отдельные stage-level fixtures, но называй их именно так. Сохрани compatibility старых valid receipts согласно текущим R1.5 правилам, не добавляя новый trust bypass.

### 3.3 Границы изменения

Основной production scope — `setup/src/adapters/git.ts` и при необходимости небольшой внутренний command-preparation module. `stages/application.ts` меняй только если это необходимо для одинакового admission. Tests/helpers/docs/report/evidence входят в scope. ProcessAdapter меняй лишь при доказанной необходимости, без общей Q1B переработки. Для каждого дополнительного production-файла объясни, почему исправление нельзя сделать в основном scope.

Не ослабляй hashes/ownership/timeout/gates; не добавляй sudo, root installer, chmod socket, newgrp, unbounded execution, новые секреты или env bypass. Не меняй S03/S04 поведение и Q1A core для того, чтобы обойти failing test. Не исправляй M0 или service/unattended в этом пакете.

## 4. Проверки и критерии приёмки

Сначала сохрани исходный audit harness без изменения oracle. Запусти W01…W04 на исходной базе и запиши реальные результаты. Нельзя считать exit 0 harness или успешный TypeScript build продуктовым PASS. Новые tests должны доказать исходный дефект на baseline; сохраняй red log, отделяя harness/setup errors от product failures.

| ID R1.6 | Что проверить | Обязательный assertion |
|---|---|---|
| W01 | `.js`, `.mjs`, `.ts` positive controls; короткое `node` и exact pinned path | Исполняется checked deployment file, обе help-пробы реальны и успешны |
| W02 | `.cjs`, CWD отличается, в CWD decoy с тем же именем | Decoy не исполняется; actual argv содержит именно checked absolute entry; trusted marker получен |
| W03 | Extensionless entry, другие CWD/decoy; CWD также без decoy | Результат независим от CWD, trusted marker получен; не потеряна работоспособность |
| W04 | Hashed `--eval` + expression + `--`, исходный counterexample | Typed refusal до Node child; inline marker отсутствует; нет `verified` |
| W05 | Option-shaped entries: `-e`, `-p`, `--eval=…`, `--print`, `--require`, `--import`, `--inspect`, `-`, `--` | Даже с реальным hashed файлом/ключом каждый запрещён grammar до executable child; опасные варианты не запускаются в тесте |
| W06 | Manifest path / executable boundary | Missing/unlisted/absolute/traversal/NUL/unsafe metadata/symlink/external/sudo entries отклоняются; sentinel trap остаётся 0 |
| W07 | Обычный file entry `bin/-runner.cjs` и безопасные application args со пробелами/кавычками/`--eval` после entry | Вложенное имя файла не путается с опцией Node; нет shell splitting, скрытого Node option или потери аргумента |
| W08 | Drift между двумя help-пробами | Первая разрешённая команда может завершиться; вторая после mismatch не вызывается; failure без ложного общего PASS |
| W09 | Настоящий S05 через engine-created materialization evidence: plan/verify/status-refresh/apply/resume | Invalid command не выполняется и не даёт нового proof/downstream; исправленный supported release проходит нужные probes; plain status не пишет evidence |
| W10 | Разрешённый `bin/check` и оба command keys, включая mixed Node/direct commands | Absolute executable соответствует content entry; native args не получают Node rewriting; команда не подменяется PATH/CWD |
| W11 | False/timeout/throw/missing probe controls, повторный verify, no-trust/config/archive/path mismatch | Сохранены прежние typed failures и trust boundaries; happy path не стал no-op |
| W12 | Regression/evidence | Все прежние 364 теста сохранены, старые frozen comparisons и 33 assertions проходят, новый evidence реконструируется |

W05 не требует реального запуска inspector/preload/import и не должен открывать сеть. Используй ProcessAdapter trap и проверяй, что вызова нет. Для W02/W03 и положительных случаев нужен хотя бы один тест через **настоящий NodeProcessAdapter** в отдельно принадлежащем тесту child с отличающимся CWD; один mock, который всегда возвращает exit 0, недостаточен. Создавай только локальные stdout/argv-printing программы, временные каталоги и минимальное окружение. Сетевые/привилегированные команды в этих тестах запрещены.

Не путай direct adapter и stage/engine assertions. Как минимум интегрируй новые grammar negatives и CWD mismatch в реальный S05 observe/verify; lifecycle tests могут перехватывать опасный process boundary, но должны проверять реальные prepared argv и отсутствие ложного journal proof. Безопасные положительные пути должны действительно дойти до process boundary.

Для покрытия вариантов не нужно плодить отдельный огромный suite: допустимы читаемые parameterized tests, если каждый input явно указан и assertion проверяет поведение. Не удаляй и не переименовывай старые tests ради нужного числа. Новое общее число тестов фиксируй фактически, не предсказывай заранее.

## 5. Что разрешено запускать

Разрешено: локальный typecheck/unit/integration, temporary FS, injected adapters, owned child processes с короткими stdout-only fixtures/контролируемыми argv, read-only git и подготовка evidence. Используй Node major 24; запиши реальную версию и OS/arch, ничего не подменяй в `process.versions`. Работай обычным пользователем; если CI/container фактически UID 0, явно укажи это как ограничение, не называй результат root-installer qualification.

**Не запускай реальные sudo/apt/systemd/SSH/UFW/Docker-daemon операции, host deployment, OAuth, реальные credentials/provider/model calls, GitHub writes, платные сервисы или VM provisioning.** Не выставляй host mutation env switches для прохождения тестов. Запуск только локальных тестовых Node children не является разрешением на реальные factory jobs.

В свежей реконструированной копии с итоговыми bytes:

```text
node --version
npm --version
npm --prefix setup ci --ignore-scripts --no-audit --no-fund
npm --prefix setup run typecheck --silent
npm --prefix setup run test --silent
```

`npm ci` не должен уничтожать dependencies в чужом рабочем дереве: используй отдельную временную копию. Запусти исходный audit harness на baseline/fixed с одними и теми же fixtures; `adapter` и `stage` modes сохрани отдельно. Если adapter contract меняется, сохрани оригинал и минимально адаптированный runner, объясни изменение и примени одинаково к baseline/fixed. Нельзя менять ожидания «decoy не исполняется» или обходить child execution.

Повтори существующие frozen R1.5 comparisons/C01…C12 и необходимую composition проверку. Существующие fault/crash cases входят в полный suite; повторять весь suite бесконечно после успешной окончательной проверки не нужно. После любых дальнейших code edits обнови manifest и повтори затронутые проверки; если редактируется tested source, старые логи нельзя назвать final bytes validation.

## 6. Отчёт, patch и evidence — без коммита

Создай `docs/audits/remediation-q1a-r1-6-2026-10-25.md` (если дата фактически другая, используй реальную дату и укажи её). Итоговая папка `audit/evidence/q1a-r1-6-<date>-local/` должна содержать:

1. `report.md`: проблема → исправление → remaining risks; список production diff; таблица R15-F01 / W01…W12 с PASS/PARTIAL/OPEN, конкретными assertions и ссылками на логи. Исправь overly broad V03 claim R1.5 новым статусом; исторический отчёт не переписывай так, будто недостатка не было.
2. `identity.json`: actual base commit/tree, branch, первоначальный owner layer, tested-tree identity, runtime/OS/arch, checksums patch/manifest/report, фактические команды и exit codes. Не выдумывай новый tested commit: его нет.
3. Полный `full-local.patch`, включая additions и deletions, полученный **без staging/commit**. Обычный `git diff` не включает untracked files: явно обеспечь полноту. Если есть исходный owner layer, отдельно сохрани его и свои изменения, плюс однозначную инструкцию восстановления всей проверенной копии.
4. `new-files.tar` или эквивалентный явный payload + `new-files.json`, `deletions.json`. Укажи, входят ли новые файлы уже в full patch, чтобы их не применять дважды. Исключи secret/temp/dependencies/Git metadata.
5. `tested-files.sha256`: все релевантные tracked setup файлы и новые source/tests/helpers/docs/config/locks/schemas/fixtures/bootstrap/release inputs; заяви exclusions. Отдельно хранить packaging/report hashes, без самоссылочного hash manifest.
6. Frozen runners/fixtures, raw stdout/stderr/exit logs, baseline red results и fixed results, machine-readable assertions. Для W02/W03 указывать hashed path, actual binary/argv/CWD, stdout/exit и schema validation; для W04/W05 — typed refusal и executable-call count 0. Не сохраняй credentials или host secrets.
7. `evidence.zip`, внутренний `SHA256SUMS`, внешний `.zip.sha256`; README с воспроизведением в пустой временной папке из base + owner layer + patch. Достаточно приложенных файлов и репозитория, без доступа к личной папке сессии агента.

Действительно восстанови итоговое дерево в пустой папке, сверь manifest и выполни окончательную validation там. Сравни его hashes до/после тестов. Зафиксируй, что initial HEAD/index/branch сохранены, чужие изменения не затронуты. Размер/формат packaging не должны скрывать ошибки тестов. CRC/checksum ZIP не заменяют продуктовые assertions.

## 7. Definition of done и ответ владельцу

R1.6 принимается локально, если:

- W02/W03 больше не выполняют CWD decoy, positive deployment entries выполняются;
- W04/W05 не доходят до executable child, даже если option-shaped filename включён в hashes;
- validator и execution используют одну grammar и одну идентичность entry;
- настоящий S05 не публикует новый `verified`/receipt после такой ошибки;
- все сохранённые security/recovery/Docker/SSH guards и новые meaningful tests проходят;
- окончательный evidence самодостаточен и соответствует фактическим local bytes;
- нет commit/push/ветки/PR/release/deploy.

Если что-то не выполнено, результат **PARTIAL**, с точным blocker, без fake green и без перехода к R2/Q1B/Q2. При полном локальном успехе напиши **R1.6 local scope PASS; production OPEN; real-host qualification NOT RUN**. Не закрывай автоматически Q1A, AF-05/06, AF-08/09/31 или весь AF-01…31 backlog.

В финальном ответе кратко укажи изменённые файлы, фактически выполненные проверки/результаты, remaining blockers, NOT RUN и путь к отчёту/patch/evidence. Единственное следующее действие владельца — передать эти локальные файлы на review. Не предлагай ему для этого совершать push, выдавать credentials, запускать sudo или разворачивать VPS. Последующие работы R2/R3/Q1B/Q2 и production qualification выполняются отдельными заданиями.
