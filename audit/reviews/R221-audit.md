# Agent Factory: независимая проверка R2.2.1 и границы R3

Дата: **27 октября 2026**, Europe/Amsterdam. Репозиторий: `se-panfilov/agent-factory`.

**Решение: R221-F01 и R221-F02 приняты в локальном объёме. Можно переходить к Q1A-R3. Production остаётся OPEN.** Дополнительный R2.2.x только ради невоспроизведённой нестабильности общего runner сейчас не обоснован. Полнота evidence стала проверяемой; причина прежнего раннего завершения по-прежнему не установлена.

Это проверка конкретного обновления установщика с независимым воспроизведением прежних матриц и новых сценариев следующего этапа. Это не новая квалификация всех AF-01…AF-31 и не аудит готовности работающей фабрики целиком.

## 1. Что именно проверено

| Объект | Значение |
|---|---|
| Проверенный master | `134ecd884ab77f537f1890b3dd456cc6592090ad` — `audit fixes 13` |
| Tree | `58a212fa5a30df32437db021f536338507890c47` |
| Непосредственный parent | `564bb05736406db7bb8f930bf9a6a14195e8f73f` |
| Предыдущий проверенный код | `ad84212831892d18ab4dbcaab0d1bfecdc103f1b` |
| Разница parent и ad842 в setup | Отсутствует; промежуточный commit содержит материалы аудита |
| Проверенные setup inputs | Все **158** tracked-файлов из manifest; совпадение с master и после тестов |
| Продуктовый diff | 4 setup-файла, +210/−25; из них 2 production-файла, 1 документ и 1 файл тестов |

После уточнения владельца master был проверен повторно. Все пять приложений побайтно совпадают с опубликованными материалами `../evidence/q1a-r2-2-1-2026-10-27-local` и отчётом `docs/audits/remediation-q1a-r2-2-1-2026-10-27.md`.

| Приложение | SHA256 |
|---|---|
| Отчёт | `11126b6e011e21e3603db04de05127f24e97521d47e7f55a7c524513ecdc589a` |
| full-local.patch | `0b9f17bbd1d105fb11abfe501281f55433d74d64aef60c71a4885e4d3e90e031` |
| tested-files.sha256 | `ea66c4cb45178ffd584e2b3680af3326543c4a0483cac6046c7d3a574ff8c428` |
| evidence.zip | `dc8a83c010c05293fc8b05cf537d5b49cf26f54a4ff69c57057046310a7c51fd` |
| evidence.zip.sha256 | `687d3c8e4719faf4d27e96b2de6891c15f324a6ecbe90ac7007ff00f3f4c1bb3` |

Входной ZIP: 439 entries, CRC PASS, все 438 внутренних SHA256 PASS. Полный patch однократно применён к обычному архивному каталогу ad842; проверены 158 source inputs и 99 новых payload-файлов. Tar повторно поверх patch не применялся. Индекс не использовался.

Рабочая копия владельца не переключалась: HEAD `7d845248…`, ветка master, существующий untracked `app/m0-02-runner/.factory-selftest-gC3VLh/` сохранён; status и SHA256 index до/после одинаковы. Исполнение шло в отдельном `git archive`-снимке. Продуктовый код reviewer не изменял.

## 2. Независимая проверка результата Copilot

| Проверка | Фактический результат |
|---|---|
| Установка setup dependencies с `--ignore-scripts`, typecheck | PASS |
| Полный setup test suite | **515/515**, fail/cancelled/skipped/todo = 0 |
| Прежние boundary-сценарии R221-F01/F02 | **14/14**, desired oracle PASS |
| Context binding | **5/5** |
| Original S03 continuation | **13/13** |
| Genuine v1 → C13 с явным review | **13/13** |
| Genuine v2 → C13 с явным review | **13/13** |
| Frozen-33 / command-37 / R2-checker-39 | PASS; наборы пересекаются, их нельзя складывать |
| Контроли обнаружения неполного evidence | **13/13** |
| Полный original replay | **Одна полная попытка**, instrumented attempts = 0, без склейки разных запусков |
| Повторная проверка exact IDs, predicates, source hashes | PASS |
| Original final-recovery desired oracle | **EXPECTED KNOWN-RED**, см. R211-O01 ниже |

Среда reviewer: Linux x86_64, Node **24.22.1**, npm **11.9.0**, actual UID **0**; в тестах явно внедрена ordinary-owner identity UID1000/Ubuntu24/amd64. Это проверка логики с тестовыми adapters, а не реальный запуск установщика от владельца VPS. APT, SSH, Docker и привилегированные эффекты подменены. Raw logs и command ledger входят в `R221-evidence.zip`.

В release boundary runner прозрачная адаптация переставляет hook с прежнего порядкового archive hash на final-admission hash. Исходник сохранён; counters и продуктовые predicates не ослаблены. Context runner использован исходный. Новые 30 регрессионных тестов покрывают также публикацию plan/review, TTL/session drift, apply/resume, gate-free путь и сохранение ранее выполненного префикса.

## 3. Почему R2.2.1 принят

**R221-F01 — PASS local.** Общая `finalPlanAdmission` выполняет policy checks, захват контекста с archive hash, повторную проверку текущего policy frontier, затем bounded перечитывание lock/identity, frozen request bytes и финальные file witnesses. TTL/gates проверяются перед intent. Последняя долгая проверка больше не оставляет прежнее воспроизводимое окно подмены config/plan/lock. Публикация plan повторно проверяет входы до prepared и перед committed. Отказ до intent не создаёт ложный applying для отвергнутой операции.

**R221-F02 — PASS local.** `gate approve` использует тот же финальный допуск. Подмена во время probes/hash не записывает approved. Approval не сохраняется из `finally`. Узкое исключение для плана, истёкшего ещё до входа в команду, только переводит старые gates в expired после остальных успешных проверок; оно не продлевает срок и не разрешает действия. Истечение во время проверки не публикует approval.

File witnesses привязывают path, dev/inode, size, mtime/ctime, mode/UID/GID/nlink/type. Это внутренние значения одного допуска, без persistent authorization cache. **Это не атомарный snapshot ОС:** конкурентная запись после последней проверки всё ещё возможна. В документации граница указана честно. Произвольные OS-level races, безопасные root writes и изоляция процессов остаются Q1B/Q2. По результатам этого аудита нельзя заявить, что TOCTOU устранён вообще.

Замечание по качеству: часть новых TypeScript-функций и тестов записана очень длинными строками. В затрагиваемом коде следующего этапа стоит улучшить читаемость и выделить именованные проверки. Отдельный цикл форматирования не нужен; массовый refactor увеличит риск без пользы для этого допуска.

## 4. Что остаётся открытым из предыдущего этапа

**R211-O02 — причина OPEN, в текущем полном прогоне NOT REPRODUCED.** Новый completeness contract проверяет точные ordered/unique IDs, counts/end marker, product predicates и exit. Это закрывает возможность назвать обрыв evidence полным PASS. Одна полная попытка не доказывает исправление причины прежних обрывов и долгосрочную стабильность. Сохранять эту проверку на R3 и перенести выяснение причины в runtime/qualification, если симптом повторится. Не гонять suite до случайного green и не склеивать частичные матрицы.

**R211-O01 — OPEN, задача R3.** В обоих original final-recovery сценариях: recover0 → repeat0 → resume8 `context_review_unproven`. Явный fresh plan/review/approval даёт resume0; install/stage/arm/cutover/tailnet/disarm остаются по 1, rollback0, checkpoint сохраняется. Проблема — не повторный cutover, а неясный итог recovery при отсутствии доказанного committed review. Безопасный выход: сохранить действительное committed evidence либо явно сообщить «восстановление данных завершено, нужен новый review». Prepared review нельзя автоматически превращать в authorization ради исходного зелёного oracle.

Copilot честно обозначил внешний сдвиг HEAD/index во время подготовки предыдущего пакета. Полный ранний staged/unstaged split до этого события не сохранён. Это ограничение provenance, а не основание приписать commit самому агенту. Текущие source bytes, полный patch и входные архивы независимо проверены. Публикация владельцем не нарушает запрет агенту на git mutations.

## 5. Независимый baseline R3: семь проблемных сценариев

Новый runner вызывает настоящий SetupEngine/lock/cancel/emergency на owned temp FS; внешние effects — fake. Он выполнен **по одному разу на ad842 и 134ecd**. На обеих версиях: **14 полных случаев, 7 desired PASS, 7 desired FAIL**. Его exit0 означает завершение сбора, не безопасность продукта. Отдельный `check-r3-probes.py --mode desired` вернул ожидаемый exit1; `--mode baseline` подтвердил точный baseline.

`lock.ts`, `emergency.ts` и `adapters/process.ts` между этими версиями не менялись. Нижеследующее — оставшийся backlog, **не регрессии R2.2.1**. Приоритет всех четырёх групп — высокий, блокирующий production-приёмку соответствующих путей; оценка не является CVSS.

### R3-F01. Недостоверная идентификация владельца lock

Факты: `L-unknown-start` подставляет живой PID, но недоступные start ticks (`null`): `recover --lock-only` возвращает0 и переносит lock. `L-invalid-shape` подставляет `{}`: JSON синтаксически корректен, metadata невалидны, однако lock также quarantined с exit0. Контроли `L-active` и `L-invalid-json` правильно отказывают; `L-known-dead` подтверждает существование нормального положительного пути.

Причина: `readExistingOwner` делает JSON cast без schema/size validation; `isStaleOwner` считает любое отличие boot/start ticks доказательством stale. В production adapter `isPidAlive` сводит любую ошибку `kill(pid,0)` к false; `/proc/PID/stat` разбирается split по пробелу. Последние два случая установлены чтением кода, отдельно системными fault injection в этой проверке не запускались.

Исправить: bounded строгие metadata; installation/full identity binding; различать alive/dead/unknown. EPERM, unreadable/malformed proc, null ticks и неподтверждённый boot не доказывают смерть. Разбирать stat с учётом скобок/пробелов в comm. Unknown сохраняет lock и даёт typed manual blocker. Смена boot требует проверки ресурсов, как предписывает C07.

### R3-F02. Recovery может забрать новую живую блокировку

`L-recovery-race`: первый recovery прочитал старый lock; перед его rename второй настоящий recovery quarantined старый lock и новый `acquireLock` создал свежий. Первый затем переименовал **новый** lock и вернул0. Новая nonce присутствует в записи runner, по исходному пути owner уже отсутствует. Это детерминированное interleaving через FS adapter, не вероятностный многопоточный стресс-тест.

В `recoverLockOnly` после проверки owner идёт rename по mutable pathname. В `release` аналогичный read → recursive remove имеет окно замены; это дополнительное статическое замечание, самостоятельного release-race прогона здесь нет. `runRecover(lockOnly)` изучает state blockers уже **после** карантина, а проверки live operations до него нет.

Исправить: согласованный протокол acquire/release/recover с точкой атомарного перехода, проверяемой identity и защитой новой генерации. Повторный read перед rename лишь сужает окно и не доказывает безопасность. Не удалять и не переносить чужой/заменённый lock; не считать неизвестные live resources отсутствующими. Подтверждённый dead/no-live случай должен оставаться работоспособным. Lock-only recovery не должен выдавать полную recovery за успешную только по переносу каталога.

### R3-F03. Отмена теряется либо принимается слишком поздно

`C-atomic-fault`: первый cancel успешно записан. Повторная публикация пишет partial JSON и получает injected ENOSPC. Старый корректный cancel утрачен; consumer возвращает false. `requestCancel` пишет прямо в конечный файл, вопреки C07 и утверждению P02 об atomic publication.

`C-late`: durable cancel опубликован во время чтений допуска, когда APT counters ещё0/0/0. До exit130 всё равно выполняется refresh=1 и появляется его полный intent/effect/verify/checkpoint. В раннем контроле `C-early` —130 и0/0/0; без отмены —0 и1/1/1. Уже запущенный APT этот тест не прерывает: запрос успевает до начала эффекта.

Исправить: atomic temp/write/fsync/rename/fsync-parent либо эквивалент с доказанными failure semantics; binding к конкретной генерации run; conditional consumption без удаления нового чужого запроса. Принятую отмену повторный неудачный writer терять не должен. Проверять cancel после длительных reads перед новой intent/effect; уже подтверждённый префикс сохранять. Exit130 допустим только при подтверждённом cleanup; unknown cleanup →8. Полное убийство дерева процессов/real apt safety проверяется позднее Q1B, не имитируется этими counters.

### R3-F04. Emergency обходит доверенную границу команд и владельца

`E-sudo`: manifest содержит только `commands.runner_stop=["/usr/bin/sudo","-n","/usr/bin/true"]`. При отсутствии доказательства доверенного deployment команда передаётся fake ProcessAdapter, PAUSED создаётся, результат0. `E-root`: injected root identity также получает0 и вызов команды. `E-missing` правильно возвращает5 без вызова.

**Реальные sudo и `/usr/bin/true` не запускались.** Доказано принятие произвольного absolute argv и отсутствие root refusal, а не успешное повышение привилегий на реальном хосте. Для реального sudo дополнительно нужна соответствующая политика/авторизация ОС. Однако C09 запрещает root CLI, а C12/C13 требуют подтверждённый stop adapter и trusted release; текущий путь эти границы не обеспечивает.

`emergency.ts` читает manifest напрямую без схемы/размеров/доверенного deployment proof, принимает любой absolute binary, не устанавливает release-root cwd для node entrypoint. Дополнительно по коду: не учитывает outputLimitExceeded; ошибка Docker inspect трактуется как foreign, что может дать ложный успех; stop exit0 не подтверждается текущим postcondition. Это статические расширения группы, не дополнительные выполненные случаи.

Исправить: ordinary-owner admission и узкая проверенная stop capability с command identity/path confinement, переиспользуя подход S05 (`adapters/git.ts`, `stages/application.ts`). Не вводить универсальный sudo executor. Подмена manifest, shell/absolute arbitrary binary, traversal/symlink, чужая installation или unknown ownership не разрешают stop. Emergency не должен зависеть от доступности обычного installation lock или создания нового plan, но это не отменяет проверку доверия. Недоступный trusted stop → честный blocked/manual; известный безопасный stop должен работать. PAUSED и частично выполненный stop сохраняются и отражаются в результате. Unknown Docker inspect нельзя называть подтверждённым foreign.

### Полная таблица baseline

| Case ID | ad842 и 134ecd | Desired |
|---|---|---|
| L-active | exit7, owner сохранён | PASS |
| L-known-dead | exit0, старый lock quarantined | PASS в контролируемом no-live fixture |
| L-unknown-start | exit0, lock quarantined | FAIL: unknown должен сохранить lock |
| L-invalid-json | exit7, owner сохранён | PASS |
| L-invalid-shape | exit0, `{}` принят как stale | FAIL |
| L-recovery-race | exit0, новая nonce quarantined | FAIL |
| C-none | exit0, APT1/1/1 | PASS |
| C-early | exit130, APT0/0/0, target events0 | PASS |
| C-late | exit130, APT1/0/0, checkpoint refresh | FAIL |
| C-atomic-control | повторный cancel потреблён | PASS |
| C-atomic-fault | ENOSPC уничтожает старый cancel | FAIL |
| E-missing | exit5, commands0 | PASS |
| E-sudo | exit0, arbitrary sudo argv передан adapter | FAIL |
| E-root | exit0, root identity допущена | FAIL |

## 6. План дальнейшей работы

| Этап | Конкретный результат и граница |
|---|---|
| **Q1A-R3 — следующий** | Четыре группы выше + явный recovery/review outcome R211-O01; реальные effects заменены adapters, сохраняется весь R221 regression set |
| Q1B | Process supervisor, environment, deadlines/output, TERM/KILL и cleanup/unknown-outcome semantics; воспроизводимость runtime |
| Q2 | Реально работающий минимальный sudo/root boundary, безопасные FS writes, S03 cutover/timer/rollback, SSH/UFW/Docker host effects |
| Q3 | Честная offline deployment цепочка с reviewed M0, повторный запуск и отсутствие скрытой зависимости от credentials |
| Q4 | Credentials/OAuth/live-budget и backup/restore в их разрешённом объёме |
| Q5, если выбран | Service/inference/platforms и прочие optional пути с соответствующими application prerequisites |
| Q6 | Disposable Ubuntu24 amd64: fresh/second/reboot/failure matrix и затем отдельный owner-run live smoke |

Это оставшиеся блоки, а не обещание определённого числа итераций. Каждый следующий проход может обнаружить дефекты. Разработка и production-аудит самой фабрики — отдельная линия; R3 не реализует отсутствующий M0/M1/M2. Сейчас владельцу не требуется готовить боевой VPS или передавать credentials.

## 7. Что передать Copilot и вернуть на проверку

1. Передать `../R3-copilot-prompt.md`, этот аудит и `R221-evidence.zip` (либо весь `evidence/R221-all-files.zip`).
2. Выполнить только R3. **Агент не делает commit/push, не создаёт ветки/worktree/PR, не меняет index, не выпускает release и не deploy. Всё остаётся локально.**
3. Вернуть report, полный воспроизводимый local patch, tested-files.sha256, evidence.zip и его SHA256. Дальнейшая публикация владельцем — отдельное решение; для проверки достаточно этих файлов.

## 8. Уверенность и ограничения

**Проверенные факты:** точная source identity, полный локальный regression run, семь воспроизводимых R3 counterexamples на двух версиях. Уверенность в этих локальных выводах — **98%**. Это субъективная оценка уверенности в интерпретации evidence, не вероятность безопасности production.

**Вывод:** перейти к R3 разумно; принятие R221 не требует искать новую причину отказать этому этапу. Уверенность в таком разграничении scope — **95%**. **Неизвестно:** причина O02, реальные межпроцессные/OS race характеристики и работоспособность privileged deployment. Численную оценку их безопасности не даю.

NOT RUN: disposable VM suite, реальная ordinary-owner/PAM/SSH session, sudo/APT/systemd/SSH/UFW, Docker daemon, реальные OAuth/credentials/provider/model calls, production deployment и квалификация приложения. Детерминированные interleavings доказывают недостатки конкретного протокола; они не заменяют физический crash/power-loss или hostile-filesystem qualification.

Основной предел проверки: часть historical runners унаследована. Их completeness и ключевые predicates прочитаны и перепроверены; новые R3 probes написаны независимо. Полной формальной верификации всех interleavings не было.

## 9. Проверяемые источники

Основной источник — зафиксированный Git-снимок и приложенный пакет с raw evidence. Ссылки привязаны к commit, не к движущемуся master:

- [Изменение R2.2.1](https://github.com/se-panfilov/agent-factory/commit/134ecd884ab77f537f1890b3dd456cc6592090ad).
- [engine.ts](https://github.com/se-panfilov/agent-factory/blob/134ecd884ab77f537f1890b3dd456cc6592090ad/setup/src/core/engine.ts): final admission, apply, gate, cancel, recover.
- [plan-context.ts](https://github.com/se-panfilov/agent-factory/blob/134ecd884ab77f537f1890b3dd456cc6592090ad/setup/src/core/plan-context.ts): witness и revalidation.
- [lock.ts](https://github.com/se-panfilov/agent-factory/blob/134ecd884ab77f537f1890b3dd456cc6592090ad/setup/src/core/lock.ts): readExistingOwner/isStaleOwner, acquireLock/release, requestCancel/consumeCancelRequest, recoverLockOnly.
- [emergency.ts](https://github.com/se-panfilov/agent-factory/blob/134ecd884ab77f537f1890b3dd456cc6592090ad/setup/src/operations/emergency.ts): manifest/command/ownership.
- [process.ts](https://github.com/se-panfilov/agent-factory/blob/134ecd884ab77f537f1890b3dd456cc6592090ad/setup/src/adapters/process.ts): processStartTicks/isPidAlive.
- [CONTRACT 1.0.0](https://github.com/se-panfilov/agent-factory/blob/134ecd884ab77f537f1890b3dd456cc6592090ad/docs/automation/CONTRACT.md): C03, C07, C09, C11, C12, C13.

В ZIP: `evidence/final-independent-check.json`, `evidence/independent-bundle/logs/`, `evidence/r3-baseline-*.jsonl`, `evidence/r3-*-oracle.json`, `evidence/source-identity.json`, `evidence/reconstruction.json`, `evidence/reviewer-final.json`.
