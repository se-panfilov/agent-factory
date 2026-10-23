# Проверка Q1A: agent-factory на 66aea67

Дата: 23 октября 2026. Проверенный `master`: `66aea67b6cc32d3c5a91f1a1ebc600663035d779` (`audit fixes 2`). База сравнения: `eb187a845820aed6ef7ebafcbd2f9ac9853179a3`.

**Решение: полезные исправления принимаются по отдельным сценариям, но Q1A целиком ещё не принят. К Q1B переходить рано.** Причина — воспроизводимые ошибки в требуемом поведении, а не только отсутствие части тестов.

## 1. Подтверждённые факты

Уверенность 100% в перечисленных локальных результатах; они не являются доказательством поведения реальной ОС или провайдера.

- Приложенный `remediation-q1a-2026-10-23.md` побайтно совпадает с отчётом в проверенном коммите. SHA-256: `b295597129fd9306071421cfaa8893f702c2a85522dac5568cec608363be4cbf`.
- Diff относительно `eb187a8`: 14 файлов, включая code/tests/docs и перенесённый предыдущий аудит. `AGENTS.md` и нормативный CONTRACT в этот diff не входят.
- В отдельной рабочей копии выполнены `npm --prefix setup ci --ignore-scripts --no-audit --no-fund`, `npm --prefix setup run typecheck --silent`, `npm --prefix setup run test --silent`.
- **На Node v24.19.0 typecheck проходит, tests: 93 passed / 0 failed.** Отчёт Copilot использовал Node v26.5.1 вне declared `>=24 <25`; повторный прогон на поддерживаемом major устраняет эту конкретную неопределённость для setup suite.
- Дополнительные безопасные probes воспроизвели **10 отрицательных сценариев и 2 положительных контроля**. В S02 и auth использованы настоящие stage functions с fake process/apt adapters. Остальные probes проверяют реальный core на временной FS и контролируемых stage fixtures.
- Исходники репозитория при review не менялись. Не выполнялись реальные sudo, apt install, systemd/SSH/firewall, Docker daemon, OAuth, модель, GitHub writes или VM provisioning.

Отчёт Copilot прямо оставляет A02/A07/A08/A10/A11/A12 как NOT RUN. Это правильно и честно. Но некоторые PASS относятся только к узкому примеру внутри более широкого критерия; ниже указаны границы.

## 2. Что исправлено и должно сохраниться

**Уверенность 99–100% по исходникам и passing regressions.**

| Изменение | Что теперь доказано | Граница доказательства |
|---|---|---|
| Verify aggregation | Проверяемый unsupported-host case получает blocked/exit 3 | Не все статусы и public entrypoints используют корректную свёртку |
| Gate expiry | Expired approve возвращает ненулевой код; TTL не обновляется в этом сценарии | Gate ещё не проверяется перед каждым отдельным эффектом внутри stage |
| Stage-only gates | Теперь сохраняются вместе с operation-bound records | Полная привязка к host/lock/resource/session не реализована |
| Recovery marker | Обычные два последовательных load после corruption больше не создают fresh state | Отказ записи marker и journal-only state обходят защиту |
| Lock coverage | Многие writers действительно перенесены под lock | Error paths в supposedly read-only load всё ещё пишут без lock |
| Cancel checkpoints | Cancel в stage A останавливает следующий stage B | Effects внутри одного `stage.apply` продолжаются |
| Optional skipped | Synthetic disabled optional с пустыми operations сохраняет skipped | Реальный dependency closure через S08 блокируется раньше |
| Dangerous entrypoints | Public restore/update blocked; совет обходить update через S14 удалён | Старые внутренние restore/update реализации не исправлены; другие paths остаются доступны |
| Subprocess test | A01 действительно запускает отдельные Node processes с разными cwd | Это engine + fake stages, не packaged CLI/M0 и не реальные S05–S07 |
| Missing lock owner | `recover --lock-only` теперь отказывается автоматически quarantine неполный owner | Полный race/PID-reuse/reboot/cleanup protocol ещё не проверен |

Это заметный прогресс. Переписывать эти исправления с нуля не нужно.

## 3. Остаточные ошибки и регрессии

P0 — блокирует эксплуатацию соответствующего опасного пути. P1 — существенная ошибка корректности, восстановления или admission. Проценты — уверенность в наблюдаемом дефекте; вероятность конкретного ущерба не оценивалась.

### Q1A-F01 — P0: read-only status изменяет state без lock

**N01, уверенность 100%.** На временной FS удерживается installation lock, primary повреждён. Вызов `status` без refresh возвращает 8, но также перемещает primary в quarantine и пишет `recovery-required.json`. Lock другого логического writer всё ещё существует.

`loadState(readOnly=true)` соблюдает запрет записи только при fresh init/config drift. Missing-primary/previous и JSON corruption branches игнорируют readOnly. Те же branches доступны из gate list, blocked restore/update/inference probe и начального чтения cancel/recover. `status --refresh` также сначала вызывает load до acquireLock.

Это детерминированная проверка поведения при удержанном lock, а не полная многопроцессная race suite.

**Требование:** read-only loader ничего не пишет/переименовывает/удаляет на любом error path. Его результат сообщает recovery-required. Любая починка или quarantine — отдельная сериализованная операция. Проверять фактические FS calls, а не только `readOnly` option.

Источники: [state.ts](https://github.com/se-panfilov/agent-factory/blob/66aea67b6cc32d3c5a91f1a1ebc600663035d779/setup/src/core/state.ts#L241), [runStatus](https://github.com/se-panfilov/agent-factory/blob/66aea67b6cc32d3c5a91f1a1ebc600663035d779/setup/src/core/engine.ts#L945). AF-05/06; A09/A11.

### Q1A-F02 — P0: recovery barrier не выдерживает отказ своей записи

**N03 и N04, уверенность 100%.** Два независимых пути:

1. Corrupt primary без previous. Loader сначала делает rename primary в quarantine; затем запись marker получает injected ENOSPC. При следующем обычном load создаётся чистый state: `last_error=null`, `in_flight_operation=null`. Quarantine существует, но не учитывается.
2. Есть непустой валидный events journal с незавершённым intent, но нет primary/previous/marker. Loader также создаёт чистый state и не связывает его с незавершённой операцией.

**Логическое последствие, уверенность 97%:** потеря такого evidence может разрешить повтор внешнего side effect. Реальный повтор пакета/OAuth/модели здесь не выполнялся.

**Требование:** fresh install нельзя определять только отсутствием двух checkpoint-файлов и marker. Нужен crash-consistent protocol, учитывающий journal/quarantine/operation evidence, в том числе отказ самого recovery protocol. Durable barrier должен переживать write/fsync/rename failure; при нехватке места исходные evidence не должны превращаться в разрешение reset.

[state.ts: fresh/quarantine branches](https://github.com/se-panfilov/agent-factory/blob/66aea67b6cc32d3c5a91f1a1ebc600663035d779/setup/src/core/state.ts#L250). AF-05; A08/A09/A10.

### Q1A-F03 — P1: recover даёт success, ничего не восстановив

**N02, уверенность 100%.** После появления recovery marker обычный `recover` возвращает `exit=0 / overall_status=ok`, marker остаётся. Код ловит ошибку load, присваивает state=null, затем сообщает, что full recovery не реализован в P02.

Fail-closed marker полезен, но сейчас для него нет честного рабочего recovery outcome. Повторное указание пользователю «run recover» ведёт в тупик.

**Требование:** различать no recovery needed, доказуемое восстановление и unresolved recovery. Последнее возвращает 8 и конкретное безопасное действие, сохраняя evidence. Lock-only success подтверждает только работу с lock и не снимает unknown operations. Нельзя исправлять проблему автоматическим удалением marker.

[runRecover](https://github.com/se-panfilov/agent-factory/blob/66aea67b6cc32d3c5a91f1a1ebc600663035d779/setup/src/core/engine.ts#L1148). AF-04/05/06; A08/A10/A12.

### Q1A-F04 — P0: единица исполнения всё ещё целый stage

**N07, уверенность 100%.** Использованы реальный `createSystemStage` и fake AptAdapter:

1. Engine строит S02 plan с simulate и install, approvals действительны.
2. Fake simulate подаёт cancel и переводит injected clock за expiry gate.
3. Реальная логика S02 всё равно вызывает `installPinned`.
4. Во время install записанный in-flight относится к **simulate / kind=observe**, а не к выполняющейся mutation.
5. После завершения stage engine выдаёт 130.

Реальных apt/sudo здесь нет: измерялся факт вызова подставного install adapter. Это не проверка завершения реального дерева процессов.

В прошлом pass intent писался для всех operations до bulk apply. Теперь intent пишется только для `operations[0]`, а `stage.apply` по-прежнему выполняет весь список. Таким образом, новая запись не является per-operation journal. Gate/cancel checks перед stage не защищают более поздние effects этой stage.

**Требование:** admission → durable intent конкретного effect → effect → receipt → verification, с cancel/expiry проверкой перед каждым необратимым действием. Неиспользуемый интерфейс executor рядом со старым bulk path не исправляет дефект. Unsupported adapter должен блокироваться до mutation. Cleanup unknown требует 8; checkpoint сам по себе не доказывает cleanup.

[engine.ts: operationForIntent](https://github.com/se-panfilov/agent-factory/blob/66aea67b6cc32d3c5a91f1a1ebc600663035d779/setup/src/core/engine.ts#L811), [system.ts](https://github.com/se-panfilov/agent-factory/blob/66aea67b6cc32d3c5a91f1a1ebc600663035d779/setup/src/stages/system.ts#L298). AF-02/03/05/06/14; A05/A08/A10/A13.

### Q1A-F05 — P0: host и фактические lock bytes всё ещё не связаны с approval

**N06, уверенность 100% для core fixture.** После plan/approve изменены bytes файла `version_lock_path` и возвращаемый process adapter machine-id hash. Core принимает старый план и выполняет временный test effect с exit 0.

Новый код проверяет installation ID, contract string, profile, declarations capabilities, зависимости и взаимную согласованность списков gates. Это полезно, но не проверяет фактическое наличие capabilities и не заменяет binding к текущему host/release/resource/owner session. Config hash хранит путь к lock, а не автоматически содержимое этого файла. Plan/config также загружаются и проверяются до lock без полной повторной проверки внутри.

Некоторые stages имеют собственные дополнительные checks. Probe не утверждает, что каждый реальный adapter одинаково обходится; он показывает отсутствие обещанного общего admission invariant.

**Требование:** свежая identity/evidence внутри транзакции, проверка actual content digests, строго определённая operation/resource binding. Не выдавать self-checksum за подпись или защиту от hostile same UID. Missing machine identity не подменять hash от `unknown-machine-id`.

[admission](https://github.com/se-panfilov/agent-factory/blob/66aea67b6cc32d3c5a91f1a1ebc600663035d779/setup/src/core/engine.ts#L457), [runApply](https://github.com/se-panfilov/agent-factory/blob/66aea67b6cc32d3c5a91f1a1ebc600663035d779/setup/src/core/engine.ts#L735). AF-02/03/05; A07.

### Q1A-F06 — P0/P1: отдельный auth entrypoint обходит in-flight barrier и врёт об успехе

**N10, уверенность 100%.** В persisted state уже есть незавершённая S08 mutation. `auth login` запускает настоящий auth function с fake Docker adapter, вместо отказа/recovery. Fake Docker возвращает 0, но auth directory пуст: `s08-auth-status.json` фиксирует `authenticated=false`, S08 наблюдается как `awaiting_manual`. Engine всё равно возвращает `exit=0`, `auth_present=true`.

Проблемы разные: нет общей политики допуска mutations при unknown effect, и command outcome не сверяется с реальным postcondition. Lock обеспечивает последовательность, но не разрешение на действие. Если re-auth нужен для отдельного recovery workflow, такая возможность должна быть явно классифицирована и проверена; сейчас это обычный login path.

Старый `approvedGate` в live smoke также использует `Date.now()` и ищет одобрение по ID/status/expiry без active plan/resource binding. Full live implementation остаётся Q4, но Q1A требовал безопасного ограничения незавершённых production paths. Запрет generic S08 не закрывает отдельные auth/smoke routes.

**Требование:** общая admission policy для всех effectful entrypoints, отдельные recovery exceptions и truthful postconditions. Пока live/OAuth protocol не готов — blocker соответствующего action; не blanket отказ read-only диагностики.

[runAuthLogin](https://github.com/se-panfilov/agent-factory/blob/66aea67b6cc32d3c5a91f1a1ebc600663035d779/setup/src/core/engine.ts#L1253), [auth gates](https://github.com/se-panfilov/agent-factory/blob/66aea67b6cc32d3c5a91f1a1ebc600663035d779/setup/src/stages/auth.ts#L352). AF-03/04/16/17; A10/A14/A16.

### Q1A-F07 — P1, регрессия: запрет S08 блокирует готовые prerequisites

**N08 + анализ dependency graph, уверенность 100%.** В fixture реальная S08 definition получает контролируемое verified observation. Её plan содержит ноль operations. S09 всё равно блокируется в generic apply, потому что admission запрещает само присутствие S08 в closure.

В production registry S09 зависит от S08, S10/S12/S13 — через S09. Поэтому запрет влияет на эти paths даже после завершённой авторизации/live qualification. Базовый S01–S07 не содержит S08. Новый A04 тест заменяет реальный dependency graph на synthetic S12→S01 и не выявляет проблему.

**Требование:** запретить dangerous S08 effects в generic apply; verified prerequisites проверять read-only, не вызывая effectful `apply` «для no-op». Невыполненный S08 по-прежнему блокирует зависимый путь и требует dedicated action. Удалять весь запрет generic S08 нельзя.

**Уточнение моего предыдущего ТЗ:** формулировка о запрете generic S08 могла подтолкнуть к слишком широкому stage-level запрету. Требование нужно формулировать через разрешённые operations и read-only dependency checks. Это не основание вернуть запуск OAuth/модели из generic apply.

[GENERIC_APPLY_FORBIDDEN_STAGES](https://github.com/se-panfilov/agent-factory/blob/66aea67b6cc32d3c5a91f1a1ebc600663035d779/setup/src/core/engine.ts#L95). AF-03/27; A04/A14/A16.

### Q1A-F08 — P1: awaiting_manual сводится к exit 5 вместо 4

**N05, уверенность 100%.** Реальная S02 с fake host report `rebootRequired=true` возвращает awaiting_manual. `status --refresh` выдаёт 5, хотя C03 для reboot/manual action требует 4. В `aggregateStageStatuses` нет ветки awaiting_manual.

**Требование:** покрыть все статусы и приоритеты C03, включая mixed mandatory/optional outcomes. Это небольшой дефект, но он показывает, почему один unsupported-host test не закрывает всю aggregation acceptance.

[aggregateStageStatuses](https://github.com/se-panfilov/agent-factory/blob/66aea67b6cc32d3c5a91f1a1ebc600663035d779/setup/src/core/engine.ts#L134). AF-04/27; A03/A04.

### Q1A-F09 — P1: A15 не доказывает sanitization

**N09, уверенность 100%.** Synthetic `Error` со строкой `password=Q1A_SYNTHETIC_SECRET` из stage verification попадает целиком в публичный JSON envelope. Никаких настоящих секретов в probe нет.

Новый A15 проверяет четыре parser errors и отсутствие текста `Error:`. Это проверка формата/parser behavior, не secret redaction. `toSetupError` продолжает переносить произвольный `error.message` в public message.

**Требование:** безопасные публичные сообщения/allowlist error fields и synthetic-secret tests всех выходов; не сохранять raw provider/error stream default. Полный logging/retention остаётся Q1B/Q4, но A15 нельзя обозначать как полный sanitization PASS.

[errors.ts](https://github.com/se-panfilov/agent-factory/blob/66aea67b6cc32d3c5a91f1a1ebc600663035d779/setup/src/core/errors.ts), [A15](https://github.com/se-panfilov/agent-factory/blob/66aea67b6cc32d3c5a91f1a1ebc600663035d779/setup/tests/integration/core-q1a.test.ts#L787). AF-27/30; A15.

## 4. Уточнённая приёмка A01–A16

PASS относится к заявленному scope, PARTIAL — к отдельному passing примеру. NOT RUN из отчёта не превращается в PASS из-за статического кода. FAIL ниже означает конкретное воспроизведение нарушения, а не полный прогон всей матрицы.

| Критерий | Оценка после review | Основание |
|---|---|---|
| A01 | PASS для engine subprocess fixture | Реальные отдельные processes/cwd, fake registry; packaged CLI не проверен |
| A02 | NOT RUN | S05–S07 fresh-process factories отсутствуют в новом покрытии |
| A03 | PARTIAL | Unsupported host исправлен; full outcomes/negative receipt matrix не покрыты |
| A04 | PARTIAL | Synthetic disabled optional проходит; mixed results и настоящий closure не доказаны; F07/F08 |
| A05 | PARTIAL | Expired approve исправлен; gate может истечь до следующего effect внутри stage; F04 |
| A06 | PARTIAL | Stage-only gate сохраняется; external prerequisite semantics заданы heuristic suffix, full matrix отсутствует |
| A07 | NOT RUN в отчёте; FAIL в core counterexample | Изменённые host/lock bytes приняты; F05 |
| A08 | NOT RUN в отчёте; FAIL на marker write failure | F02 |
| A09 | PARTIAL | Обычный marker работает; read-only/error/fresh detection cases сломаны; F01/F02 |
| A10 | NOT RUN в отчёте; FAIL в дополнительных сценариях | Journal-only reset; direct mutation при in-flight; F02/F06 |
| A11 | NOT RUN в отчёте; FAIL на read-only interleaving | Удержанный lock не защищает от status error path; F01 |
| A12 | NOT RUN | Missing owner теперь безопасно отказывается; полный concurrent recovery/identity matrix отсутствует |
| A13 | PARTIAL | Между stages отмена работает; внутри реальной S02 — нет; F04 |
| A14 | PARTIAL | Restore/update contained; остальные effectful paths и read-only dependency policy незавершены; F06/F07 |
| A15 | PARTIAL | Parser tests проходят, runtime synthetic secret утекает; F09 |
| A16 | PARTIAL | Положительные случаи есть, работоспособность всего заявленного lifecycle не доказана; F07 |

Нельзя честно объявить Q1A завершённым по этой матрице. При этом отсутствие реального sudo/VM не мешает закрыть перечисленные core tests: для них достаточно безопасных fixtures и subprocesses.

## 5. Что делать дальше

**Инженерная рекомендация, уверенность 97%:** закончить Q1A тремя короткими последовательными пакетами. Общий план Q1B→Q6 из предыдущего review сохраняется; добавлять новые production features сейчас не нужно.

| Пакет | Результат | Что закрывает | Условие перехода |
|---|---|---|---|
| **Q1A-R1 — сейчас** | Чистые read-only paths; durable state/recovery protocol; truthful recover; общий запрет обычных effects при unresolved state | F01/F02/F03, часть F06; A08/A09/A10/A11 по state | Fault matrix проходит; ни один повторный load/обычный effect не стирает uncertainty |
| **Q1A-R2** | Общий fresh admission/binding, truthful outcomes, safe entrypoint policy и настоящий dependency graph | F05/F06/F07/F08/F09; A02/A03/A04/A06/A07/A14/A15/A16 | Проверены подмена identity, dependency closure и ошибки; dangerous effects не маскируются no-op |
| **Q1A-R3** | Реальное per-operation execution/journal, cancel/expiry checkpoints, полный lock/recovery concurrency matrix | F04; оставшиеся A05/A08/A10/A11/A12/A13 | Реальная S02 с fake apt не начинает install после cancel/expiry; неизвестный cleanup сохраняется |

R1 не является закрытием всего AF-05/06 или всего Q1A. R2/R3 могут потребовать изменения соседних модулей; их приёмку нельзя заменить заглушкой, тестирующей только саму заглушку. Полный process-tree supervisor остаётся Q1B; до него соответствующие production paths не квалифицированы.

Новый промпт `../copilot-q1a-r1-state-recovery.ru.md` задаёт **только R1**. Он намеренно меньше прежнего Q1A задания. Это уменьшает риск очередного pass, где много файлов изменено, а ключевые fault cases остаются NOT RUN.

### Действия владельца сейчас

1. Передать Copilot новый review и промпт R1, попросить отдельную ветку от актуального master. Переписывать уже merged историю не нужно.
2. После выполнения получить source SHA, diff и таблицу R1 tests; проверять на Node 24. Прислать их для следующего review.
3. VM, реальные sudo/credentials/GitHub workflow/VPS для R1 не нужны. Не удалять recovery marker/quarantine/state вручную, чтобы «разблокировать» текущий код: это уничтожает evidence.

`setup/docs/privileges.md` тоже нужно уточнить: сейчас неверны безусловные утверждения о read-only paths, checks «между effects» и полноценной привязке per-op intent. Документ должен описывать реализованное поведение и оставшиеся blockers.

## 6. Границы и самопроверка

- **Подтверждено, 100%:** 93 tests на Node 24; результаты N01–N10/P01–P02; совпадение приложенного отчёта с source commit. Архив `agent-factory-q1a-evidence-66aea67.zip` содержит код probes и полные логи.
- **Вывод, 99%:** текущий Q1A не проходит собственную приёмку; production safety не подтверждена. Это не заявление о произошедшем взломе или remote root-RCE.
- **Вывод, 97%:** следующий полезный шаг — завершённый recovery пакет; ускорять Q1B поверх ненадёжного state увеличивает стоимость последующей переделки.
- **Неизвестно:** реальные sudo/OS/provider behavior и длительность remediation. Они не оценивались как будто уже проверены.

Моё предыдущее ТЗ было слишком широким для одного завершённого pass, а формулировка generic S08 недостаточно различала effects и prerequisites. Это уточнено. Новая проверка остаётся review изменённого core и критических соседних paths; она не заменяет полный повторный аудит неизменённых Q2–Q5 компонентов и VM qualification.
