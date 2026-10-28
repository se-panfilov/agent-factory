# Copilot: Q1A-R1.5 — безопасные S03/S04/S05 после R1.4

Выполни следующий ограниченный remediation-pass по Agent Factory. Это задание на исправление кода и проверяемый локальный результат, не на очередной декларативный аудит.

**ОБЯЗАТЕЛЬНО: НЕ ДЕЛАЙ КОММИТЫ, НЕ ПУШЬ, НЕ СОЗДАВАЙ ВЕТКИ И PR. Все изменения оставь локально в текущей рабочей копии. Это прямое указание владельца, приоритетное относительно обычного branch/commit/PR workflow из файлов репозитория. Не используй `git add`, stash/reset/clean или переключение ветки для подготовки результата. Не публикуй релизы и ничего не развёртывай.**

## 1. База и границы задания

Проверенная база master: `2eb026527d3448fc0d455f6fe8713cba61c0d3c5`, tree `5db7df2b8f313e9213f524f217772e5aad6d398a`.
Code commit предыдущего отчёта: `4c28f49228a01a0cb4e8f25a7504883c90ea8672`; отличие от master — только report/evidence packaging.

Прочти:

1. Приложенный `agent-factory-r14-audit-2eb0265.ru.md`, evidence ZIP и этот prompt.
2. `AGENTS.md`, `docs/automation/CONTRACT.md`, применимые ограничения implementation-плана.
3. `docs/audits/remediation-q1a-r1-4-2026-10-24.md`.
4. `setup/docs/lifecycle-r14.md`, `stage-inventory.md`, `privileges.md`, application/Docker docs.
5. Production-код и тесты, на которые ссылается аудит; отчёт не является доказательством реализации.

В начале запиши `git rev-parse HEAD`, `git status --porcelain=v1`, имена и хеши существующих изменений. Сохрани чужие staged/unstaged/untracked файлы и состояние index. Если HEAD отличается, сравни изменения с проверенной базой и явно укажи применимость замечаний. Не возвращай дерево к базе принудительно. Не проси разрешения на обычные локальные обратимые правки, уже предусмотренные этим заданием.

Контракт `FACTORY-SETUP-CONTRACT 1.0.0`, публичные CLI/config/state schemas и exit-code enum не менять. Внутренние типы observation/progress можно расширить при необходимости, с тестами совместимости. Не заменять recovery протокол очередным общим рефакторингом: его исправления R1.4 нужно сохранить.

Работа только над **R14-F01, R14-F02, R14-F03**, достоверностью их тестов и документации. Не начинать R2/R3/Q1B/Q2/Q3/Q4/Q5/Q6 автоматически. Выявленный независимый blocker записывай точно, не маскируй и не расширяй задачу до переписывания проекта.

## 2. R14-F01: integrity refusal должен предшествовать запуску приложения

Текущее нарушение: `setup/src/stages/application.ts` в `observe()` и `verify()` сначала получает mismatches, затем безусловно вызывает `probeCommands()`, а результат hashes проверяет позднее. На уже успешно установленном journal-bound release достаточно изменить `runner.js`: `plan`, `verify`, `status --refresh` всё равно запускают probe. `--help` не является безопасной песочницей.

Требуемое поведение:

- При mismatch/missing/unreadable/unsafe content и недостаточном trust evidence **ноль application command invocations**. Это должно соблюдаться до входа в process adapter, не только до публикации `verified`.
- Сначала current integrity/trust checks, затем обязательные bounded offline probes. Ошибка integrity и неуспешный probe — разные типизированные причины; сохранить соответствие публичному exit-code contract. Для нарушения целостности не выдавать ложное сообщение, будто запускался корректный runner и лишь вернул ошибку.
- Применить общую проверенную последовательность к `observe`, `verify`, отдельной probe-операции `apply`, а также к повторному apply/resume. Между materialization и probe могут измениться файлы: предыдущий receipt и хеш archive не доказывают текущие deployed bytes.
- Проверять тот deployment/manifest/commands, который связан с config, reviewed release и journal-bound receipt. Не использовать наличие source_commit marker как executable authorization.
- Отказ не должен порождать успешный probe receipt, verify/checkpoint для проваленного probe или новый `verified`; последующие зависимые stage effects запрещены.
- Для корректного приложения probes всё ещё обязательны, реально вызываются и проверяются. Не устранять проблему удалением вызова, unconditional success, игнорированием mismatches либо доверением только старому state.
- `status` без refresh остаётся чтением записанного состояния без запуска команд и изменения evidence.
- Не добавлять sudo к probes и не запускать весь installer под root. Нынешние отдельные Q1A/Q2 owner/security blockers не объявлять закрытыми этим исправлением.

Минимальные тесты на отдельных fixtures:

1. Настоящий engine успешно выполняет S05, создавая настоящее доверенное progress evidence. После этого подмена executable → `plan`, `verify`, `status --refresh`: probe counter не увеличился, trap executable не вызван, причина отказа/наблюдения соответствует integrity failure.
2. Missing file, hash-read failure, неподдерживаемая/небезопасная структура путей → также zero spawn.
3. Подмена между checkpoint materialization и следующей probe-операцией → zero executable spawn, нет downstream effects и ложного probe checkpoint.
4. Чистый release → probes действительно вызываются; false/timeout/missing required command по-прежнему блокируют; повторный успешный verify работает.
5. Existing checkout без journal-bound trust не исполняется при plan. Исторический receipt другого config/release не подходит.

Между отдельным hash-read и exec всегда остаются вопросы OS-level TOCTOU. Не заявляй полное устранение всех таких атак, если оно не реализовано; обязательный результат этого пакета — никакого запуска при **уже обнаруженном** нарушении и покрытие checkpoint→probe drift.

## 3. R14-F02: реалистичный чистый Docker install → pause → resume

Текущее нарушение: S04 проверяет owner-доступ к daemon после restart **перед** добавлением owner в docker group. Новый `verifyOperation` требует `daemonReachable && apiCompatible`. Production `NodeDockerAdapter` получает их через обычные `docker info/version`. У owner без активного membership безопасный socket root:docker 0660 недоступен. В результате exit 8/in-flight restart, group update не выполняется.

Зелёный U06 этого не ловит: fake install безусловно делает daemonReachable/apiCompatible true, даже когда у процесса нет группы.

Требуемое поведение:

- Сначала выполнить согласованные операции, не требующие owner Docker API access, и durably подтвердить account membership. При неактивной группе опубликовать явный manual pause **до операции, успех которой зависит от этого доступа**.
- Предпочтительное небольшое исправление — корректная перестановка group operation и session boundary перед зависимыми daemon/runtime checks. Можно выбрать иной строгий дизайн, но отдельно доказать service state и owner session access; нельзя просто ослабить verifyOperation до `true`.
- Pause: exit 4 с понятным next action, `awaiting_manual`, `in_flight_operation=null`, complete checkpoint и journal/config-bound receipt. Не оставлять известный успешный group update как unknown effect.
- Повторный вызов из старой сессии возвращает manual action до нового effect/intent; install/group/restart/probe не повторяются без необходимости.
- После нового owner login с активной group: свежая оценка host/плана/gates по текущему протоколу, продолжение оставшихся операций, проверка daemon/API и resource fixture, итоговый `verified`. Второй успешный resume идемпотентен.
- Account DB membership и effective groups текущего процесса — отдельные величины. Фикстуры должны сохранять это различие. `id -nG USER` не заменяет `id -nG` текущего процесса.
- Не приравнивать permission denied, daemon down, malformed output и неизвестные workload data к корректному пустому daemon. Не принимать неизвестность как доказательство безопасности restart/config mutation.
- Сохранить запрет adoption чужого Docker, foreign workloads, TCP API/public exposure/world-writable socket и неподтверждённого прогресса.
- Настоящий отказ restart/API/resource probe после активного login должен остаться ошибкой с корректной uncertainty. Не превращать любой отказ в relogin и не переигрывать неизвестный эффект автоматически.

Запрещённые «решения»: `sudo docker` как постоянный обход, `chmod 666`, root installer, NOPASSWD-all, автоматический shell через `newgrp`, фиктивная доступность daemon в mock, удаление postcondition verification.

Тесты:

1. Actual `NodeDockerAdapter.observe` + intercepted ProcessAdapter: socket 0660, нет effective group, `docker info/version/ps` → permission denied; доступность не становится true. Все команды только перехвачены, реального sudo/Docker нет.
2. Engine: absent packages/group, account=false/process=false, daemon API denied даже после package install. Первый apply должен дойти до подтверждённого group update и безопасного pause, не до ошибочного restart intent.
3. Новый объект engine в старой сессии → no extra effects, exit 4, no unknown journal; затем новая active session → успешное продолжение без повторного install/group; ещё один resume → идемпотентность.
4. Owner уже в account DB, но процесс со старыми группами; owner уже имеет активную группу; установленный unmanaged Docker; несоответствие receipt/config/package pins; daemon down/API mismatch; foreign/public/socket hazards.
5. Failure/crash на group write/checkpoint/pause boundary: известный подтверждённый прогресс сохраняется, unknown не переигрывается. Fault выключен на свежем fixture → ожидаемый positive outcome.

Не внедряй весь Q2 privileged executor под этим тикетом. Реалистичные fake/contract tests должны работать локально; реальные sudo/apt/systemd/Docker qualification — NOT RUN.

## 4. R14-F03: полный либо явно ограниченный SSH Include inventory

Текущее нарушение: `observeAccessInputProof()` хеширует главный файл и стандартный каталог, но не следует Include и не блокирует неподдерживаемые Include. Изменение `/etc/ssh/extra/access.conf`, указанного в главном файле, не меняет contentHash/ownershipHash. Conditional Match может не менять общий `sshd -T` без соответствующего connection context.

Требуемое поведение:

- На admission должен быть либо полный детерминированный proof поддерживаемого include graph, либо typed fail-closed до intent/effects с точным ограничением. Молчаливое игнорирование части graph запрещено.
- Выбери минимальный безопасный вариант: (A) bounded resolver поддерживаемых OpenSSH Include, либо (B) поддержка документированного стандартного Ubuntu layout с явной блокировкой всех неподдерживаемых вариантов. Не требуется во что бы то ни стало реализовать универсальный parser; требуется отсутствие ложного полного proof.
- В обоих вариантах разбирай директивы во всех уже принятых файлах, включая drop-ins и Match contexts. Неподдерживаемая вложенная директива не должна теряться.
- Обработать case-insensitive Include, whitespace/comments, quotes, multiple paths, relative paths, glob, nested includes, циклы, лимиты файлов/глубины/суммарных bytes. Неподдерживаемый синтаксис отклонять, а не угадывать.
- Inventory должен обнаруживать изменение набора совпадений glob, появление/исчезновение файла, изменение содержимого и ownership/mode. Избегать symlink traversal и выхода за явно допустимую область. Не открывать FIFOs/devices и не использовать shell для globbing/парсинга.
- Сохранить существующие bounds 256 KiB/file, 2 MiB aggregate и ограничение inventory либо обоснованно уточнить их с тестами. Ограничить также обход directories и recursion; файл с «неизвестной» Include не может дать зелёный proof.
- Collector должен читать через injected filesystem; не вызывать реальные системные операции в тестах. `EACCES` не превращать в empty/absent success и не исправлять permissions автоматически.
- Поддерживаемый standard Ubuntu layout должен продолжать работать; unsupported configuration должна возвращать понятный blocker ещё при plan/admission. В docs явно указать пределы поддержки.
- Сохранить R1.4 pre-intent drift guard и привязку предыдущего operation receipt. Собственные допустимые cutover changes не должны ошибочно считаться чужим drift, а несвязанные изменения между операциями не должны приниматься.

Тесты на настоящем collector:

1. Внешний Include и nested Include: изменение content или ownership меняет proof, **либо** исходная конфигурация отклоняется как unsupported. Нельзя принять конфигурацию и затем игнорировать изменение.
2. Conditional Match, lowercase keyword, quoted path, несколько путей; либо корректный результат, либо явный safe refusal согласно support policy.
3. Glob membership add/remove, cycle/depth/count/byte overflow, missing/unreadable include, symlink file/directory, special file. Проверять zero mutation и ограниченность чтений.
4. Standard layout positive control; content/owner drift после plan/approval и до первого intent → typed refusal, zero access side effects.
5. Связка actual collector → Access stage → engine: отсутствие риска не должно доказываться одним вручную установленным hash в FakeAccessAdapter. Effective-config dump в negative fixture может оставаться прежним; raw inventory всё равно должен сработать.

Не реализовывай сейчас реальный SSH/firewall cutover или root helper. `NodeAccessAdapter.applyCutover`, rollback/timer stubs остаются отдельным **Q2 code blocker**, не только NOT RUN.

## 5. Сохранить работающие защиты R1.4

Результат не принимается, если новые fixes ломают:

- engine-generated `apply → plan → missing primary` recovery напрямую и после marker;
- immutable prepared decision, uniform evidence admission, quarantine/foreign/malformed/unknown refusal до записей;
- receipt identity/config/journal binding, operation checkpoints и clean final proof;
- сохранение S02 progress перед late failure, separate-process crash/recovery controls;
- отсутствие ложного `verified` после final manifest I/O error;
- отсутствие `stage.apply` для empty/verify-only plans;
- S03 rollback guard при failed private-tailnet check;
- local S00…S07 stage compatibility, S06 no-op и блокировку downstream после failed S05;
- typed errors, reader non-mutation, lock ownership и существующие entrypoint guards.

Не удалять guard для исправления теста. Не менять исторический смысл ID R11/R12/R13 и K/T/U. Новые критерии обозначить V01…V12; mapping указать явно.

| ID | Обязательное evidence |
|---|---|
| V01 | Deployed S05 tamper → plan/verify/status-refresh, zero probe spawn |
| V02 | Integrity failure между materialization и probe; zero downstream effects/false checkpoint |
| V03 | S05 valid release positive, failed/timeout/missing probes negative, no-trust negative |
| V04 | Actual Docker adapter permission-denied contract control |
| V05 | Realistic clean S04 install → durable manual pause, no session-dependent effect до pause |
| V06 | Old/new session, fresh engine, resume/repeat, no install replay |
| V07 | Docker foreign/unsafe/unknown conditions и negative failure/crash controls |
| V08 | External/nested/conditional SSH Include: proof change либо explicit unsupported refusal |
| V09 | Glob/ownership/symlink/read/size/depth/cycle boundaries, standard layout positive |
| V10 | Actual collector + engine, approval-to-effect drift refusal до intent |
| V11 | Полная прежняя локальная suite и выбранные C/K/T/U crash/recovery guards |
| V12 | Local-only identity, воспроизводимый patch/manifest, точный report и архив |

## 6. Порядок работы и разрешённые файлы

1. Зафиксируй base HEAD и исходный working-tree manifest **без коммита**. Воспроизведи N01/N02/N02a/N03 до правок; отличай harness failure от product failure.
2. Добавь regression tests с ожидаемым безопасным поведением. Продемонстрируй meaningful failure на baseline; positive controls должны исключать неработающий harness или отключённый fault.
3. Исправь три finding минимальными понятными изменениями. Держи input proof, service health, effective groups и history receipts разными понятиями.
4. Выполни targeted tests, затем полную setup suite/typecheck. После финальных code edits validation повторить; не маркировать tested код, изменённый уже после проверки.
5. Обнови документацию и матрицу статусов; упакуй локальный результат. Не переходи к следующему пакету.

Основные файлы: `setup/src/stages/application.ts`, `docker.ts`, `access.ts`, при необходимости их `adapters/git.ts`, `adapters/docker.ts` и внутренние типы; corresponding unit/integration tests/helpers; setup docs и новый audit report. Core engine/state менять только при доказанной необходимости для этих трёх задач и с сохранением recovery regressions. Не трогать app/M0 и чужие изменения ради удобства тестов.

Нужны содержательные tests поведения, а не snapshot, копирующий реализацию. Не замещать проверяемый production method stub-методом с желаемым ответом. В engine tests использовать production producer; external effects — fake adapters с реалистичной причинностью и counters/traps.

Независимый `r14-new-probes.cjs` использует frozen fixtures из evidence. Прогони его на baseline и исправленном дереве с **теми же** fixtures. Значение `harness_ok` не является acceptance. Для N01 ожидается zero extra probes; для N02 — безопасный manual pause с подтверждённой group; для N02a — корректное распознавание недоступного socket; для N03 — proof change или explicit refusal. Если интерфейс изменился и harness нужно адаптировать, сохрани исходный runner, опиши адаптацию и не ослабляй исходный сценарий.

## 7. Валидация и запрет реальных внешних эффектов

Проверить на Node 24.x и записать фактическую версию:

```bash
node --version
npm --version
npm --prefix setup ci --ignore-scripts --no-audit --no-fund
npm --prefix setup run typecheck --silent
npm --prefix setup run test --silent
```

Если setup dependencies уже установлены и не менялись, не уничтожай чужие рабочие файлы ради чистоты среды; для reproducible validation можно сделать временную копию проверяемых файлов с сохранением SHA manifest. **Не создавай branch/worktree как обход запрета на ветки.** Обычная временная файловая копия или `git archive` base плюс полный patch/new files допустимы.

Не выполнять реальные sudo/apt/systemd/SSH/UFW/Docker daemon команды, OAuth/login, provider/model calls, GitHub writes, provisioning VM/VPS, доступ к production credentials. Перехваченный `/usr/bin/sudo` в fake ProcessAdapter допустим как проверка argv; реальный subprocess sudo — нет. Child crash tests могут завершать только созданные ими тестовые процессы.

Во всех отчётах явно оставить NOT RUN для VM/live/privileged paths. Состояние Q1A/AF-05/AF-06/production не превращать в PASS из-за числа unit tests. S03 real adapter и Q2 привилегии по-прежнему открыты, даже если V01…V12 будут зелёными.

## 8. Требуемые локальные артефакты

Создай отчёт `docs/audits/remediation-q1a-r1-5-<actual-date>.md` с:

- base commit и исходным состоянием дерева; точным списком сохранённых чужих изменений;
- mapping R14-F01/F02/F03 → V01…V12 → production change → конкретный test/command/log;
- результатами baseline/fixed на одинаковых fixtures и фактическими counters;
- фактическими командами, exit codes, количеством passed/failed/skipped tests;
- отдельными PASS/PARTIAL/OPEN/NOT RUN; для частичного решения — точными поддерживаемыми и запрещёнными случаями;
- оставшимися blockers и рекомендацией по готовности **только R1.5 local scope**;
- подтверждением: никаких commits/push/branches/PR от агента.

Передай владельцу в локальной выходной папке:

1. Report.
2. Полный воспроизводимый patch относительно base HEAD, включающий новые файлы. Одного `git diff` недостаточно для untracked: включи их отдельным payload с путями и SHA-256 либо полноценным добавляющим patch. Не добавляй их в index ради генерации patch.
3. `identity.json`: base commit/tree, actual Node/npm/OS, алгоритм reconstruction, manifest hash проверенного набора файлов. Не выдумывай tested commit SHA: новый коммит делать запрещено.
4. `tested-files.sha256` для всех source/test/config/lock/schema файлов, влияющих на проверку; manifest должен охватывать новые файлы и deletions. Build outputs/dependencies/secrets исключить и описать исключения.
5. Evidence ZIP: command logs, counters, baseline/fixed outputs, regression runners/fixtures, acceptance matrix и SHA256SUMS. Рядом SHA-256 ZIP.

Проверь, что base + patch + new-file payload в отдельной временной копии воспроизводят проверенный manifest. Сохрани исходные чужие правки отдельным обозначенным input layer, если они участвовали в тестируемом дереве; явно отличи их от своей delta. Нельзя получить «чистый» результат потерей чужого файла.

В итоговом сообщении владельцу: что исправлено, что осталось, фактическая валидация, пути report/patch/evidence. Коротко объясни, какие файлы приложить для следующего аудита: **поскольку изменений нет на GitHub, нужен локальный patch/new files/manifest**, а не только ссылка на master.

Заверши после готового локального результата. **Не коммитить, не пушить, не создавать ветки/PR, не начинать следующий этап.**
