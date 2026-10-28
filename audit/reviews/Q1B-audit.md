# Q1B — независимая приёмка, 28 октября 2026

**Вердикт: CHANGES_REQUIRED_LOCAL.** Следующий шаг — Q1B-R1, не Q2. Два воспроизведённых замечания приведены ниже. Продукт reviewer не изменял. R31-F01…F04 не переоткрываются; прежний ACCEPTED_LOCAL R3.1 принимается как переданная история.

## 1. Проверенная идентичность

| Объект | Значение |
|---|---|
| Исторически принятый product baseline | `01d804ffec9848c0e4e57da993971f50488c805e` |
| Named base полного Q1B patch | `9c9dc19f5ef7795e698c8f3ebaaa637621f38f8e` |
| Первый новый commit | `a1d57546810f38352c333350539f4381b3dff86d` |
| Второй новый commit, проверенный master | `2026fe1ebf8348fa4729e6e76bbec9404ee2ac71` |
| Tree проверенного master | `f60d4bbe0e528fb9c8833da4dd2a2897d81fb4c3` |
| SHA256 полного patch | `9eeb09f192e1ae0217a6244650a900a89dcec6ec9e5adb5e73abd99e56295eef` |
| SHA256 tested-files | `6ec5b32d406b0a721aadd2ee25afc3fb898e754118943822ef29af9be0cc6b6e` |
| SHA256 исходного evidence ZIP | `b50f273ed6df5fceb79e315cc14da8dd7b825634adc33b192a9eebf4d92e8404` |

Оба новых commit названы `audit files`, но вместе содержат **product delta**: 30 файлов setup, 1016 additions / 265 deletions. Первый содержит изменения существующих setup-файлов; второй добавляет в том числе новые supervisor/policy/lifecycle modules и tests. Поэтому второй commit нельзя считать исключительно audit-only по его сообщению.

Опубликованный setup побайтно совпал с восстановленным кандидатом. Все **303/303** source/runner/config/test inputs manifest совпали с master, повторная сверка после проверок также без расхождений. Все **665/665** записей внутреннего SHA256SUMS ZIP проверены. Сохранён reconstruction-independent.json предыдущего шага: patch применён один раз к named base, 303 tested inputs и 170 payload entries совпали; повторно patch не применялся.

Git-объекты получены в отдельное bare object storage, snapshots — обычные каталоги. Product/index владельца не редактировались; commits, branches, worktree, staging, push, PR, merge, tag, release, deploy не выполнялись. Owner layer в переданном patch не является изменениями reviewer.

## 2. Подтверждённые замечания

### Q1B-F01 — HIGH: пустое наблюдение Linux group превращается в доказанную смерть

**Факт, уверенность 100% для воспроизведённой среды.**

`setup/src/adapters/process-supervisor.ts:13–35`: после успешного `process.kill(-pgid, 0)` выполняется census `/proc`. Если не найден ни один процесс данной группы и нет ошибок чтения, функция возвращает `dead`. Код не различает «положительно наблюдал только zombie/dead members» и «не увидел группу вообще». Отсутствует проверка согласованности PID namespace Node и procfs. Затем строки 161–164 фиксируют groupAbsent и допускают confirmed cleanup при закрытом I/O непосредственного parent.

В reviewer environment `process.pid=7`, а `/proc/self/stat` начинается с PID `654`. Это конкретный факт несовместимого представления PID; точный механизм виртуализации не установлен. Производственный Linux путь был вызван без подмены adapters и без изменения procfs. Это **не** доказательство такого же сбоя на обычном Ubuntu с согласованным procfs.

Безопасный собственный Node parent создаёт обычного потомка в своей группе, `stdio: ignore`; parent завершается через 150 мс. Потомок пишет синтетический файл через 700 мс и самостоятельно заканчивает через 1100 мс. Нет setsid, daemonization, privileged effects или чужих процессов.

Результат повторного probe:

- supervisor вернулся за ~225 мс;
- `exitCode=0`, `terminationReason=null`, `cleanup=confirmed`;
- потомок **после возврата** записал файл: `writeAfterReturn=true`.

Первое воспроизведение также сохранено: ~215 мс и тот же результат. Raw: `group-census.jsonl`, `group-census-confirm.jsonl`; runner: `group-census-probe.cjs`.

**Вывод, уверенность 99%:** для недоказуемого census fail-closed нарушен. Такой result проходит `commandSucceeded`; lifecycle не получает cleanupUnknown, поэтому существующая защита удержанием lock не срабатывает на этот факт. End-to-end overlapping apply здесь отдельно не воспроизводился — это риск по цепочке кода, а не заявленное наблюдение.

**Требование:** согласованность наблюдаемого пространства идентичностей проверять до доверия census, желательно до spawn. Успешный kill(0) + отсутствие положительного group evidence не равно dead. На unsupported/несогласованной среде допустим typed pre-spawn blocker либо bounded unknown с сохранением защиты; нельзя возвращать confirmed. Сохранить legitimate ESRCH и доказанный zombie-only cleanup, normal positives и 10s TERM→KILL на квалифицируемой среде. Не вводить host PID translation или широкие сигналы.

### Q1B-F02 — MEDIUM: синхронная ошибка spawn обходит cleanup

**Факт, уверенность 100%.**

`process-supervisor.ts:83,106–108,176–184`: abort-listener и scope registration создаются до `spawn`, но try/finally начинается только после spawn и установки обработчиков. Синхронный throw не проходит cleanup.

Разрешённый валидатором аргумент длиной 200000 bytes приводит к безопасному `spawn E2BIG` до запуска Node target. Результат:

- наружу выброшен нетипизированный `Error`, `code=E2BIG`, без CommandResult;
- в RunLifecycle.processes осталась запись с `pid:null`, cleanupUnknown=false;
- без scope у переданного AbortSignal остался один abort-listener.

Первый и повторный raw сохранены в `spawn-sync*.jsonl`; runner — `spawn-sync-probe.cjs`. Это не evidence живого процесса после E2BIG и не remote exploit. Нарушены заявленные единый lifecycle, cleanup всех listeners/registrations и модель результата spawn failure.

**Требование:** охватить синхронный spawn failure общим settle/cleanup, корректно вернуть нормализованный failure либо явный typed refusal, без утечки регистрации/обработчиков и без raw argv/env в ошибках. Не считать `pid:null` живым процессом; не ослаблять ENOENT/EACCES и successful execution tests. Проверить последующий обычный запуск в том же scope и repeated failures.

## 3. Что проверено и чего не утверждаем

Среда reviewer: Linux x86_64, Node24.22.1, npm11.9.0, **actual UID0**, application UID1000 только в injected fixtures. Ordinary-owner/PAM/Ubuntu host qualification не выполнена. Несогласованность `/proc` существенно ограничивает интерпретацию real-child tests.

### Прогоны reviewer

1. Первый полный driver: ci/typecheck PASS, suite 697 cases, **245 PASS / 452 FAIL**, skipped/cancelled/todo=0. Snapshot получен git archive с режимами0664, скопированный versions.json закономерно отвергнут `context_file_unsafe`. Это ошибка подготовки reviewer, не 452 продуктовых регрессии. Дополнительно real-child Q1B tests показали отсутствие ожидаемых TERM/KILL; это послужило основанием целевого probe F01. Полные raw и ledger первой попытки сохранены.
2. Второй driver: отдельный `/tmp` snapshot с корректными source modes и теми же bytes; stderr фиксирует `AssertionError: ('test', 1, 0)`. В ходе просмотра ранее упавшие engine-сценарии проходили. **Подробные логи второго прогона не пережили продолжение сессии; итоговый счётчик неизвестен.** Эта попытка имеет статус FAIL с неполным доступным evidence, не принимается как полный qualification run. Не восстанавливать число PASS по догадке.
3. Независимые F01/F02 probes сохранены в workspace и повторены на опубликованном snapshot. Оба дефекта воспроизведены. Ни одного полного green run reviewer не получил. Обязательные inherited matrices после suite driver не достиг; они **NOT RUN reviewer**. Части попыток не склеены.

Переданный Copilot attempt3 заявляет 697/697, 62 ledger entries, 22 inherited matrices и две Q1B matrices на macOS/UID501. Целостность bytes/raw подтверждена; эти результаты остаются **результатами Copilot**, не новыми reviewer executions. Наличие source checksums не означает функционального PASS.

### Матрица приёмки reviewer

| ID | Статус в текущей приёмке | Основание/ограничение |
|---|---|---|
| B-A01 | PARTIAL | Original/mapped materials и baseline evidence доступны; baseline заново не запускался |
| B-A02 | FAIL | F02: synchronous spawn exception вне cleanup |
| B-A03 | FAIL | F01: живой собственный descendant после confirmed cleanup |
| B-A04 | FAIL | F01/F02: неполная observation boundary и listener/registration cleanup |
| B-A05 | PARTIAL | Shared byte budget/UTF8 реализованы; prompt termination зависит от F01 |
| B-A06 | PARTIAL | Closed env policy просмотрена, positives/negatives есть в пакете; отдельной полной независимой матрицы нет |
| B-A07 | PARTIAL | Policies и full outcome helpers внедрены; F02 оставляет raw failure route |
| B-A08 | NOT RUN | Независимый полный CLI matrix не достигнут |
| B-A09 | NOT RUN | Независимый cross-process matrix не достигнут |
| B-A10 | PARTIAL | Lock retention при cleanupUnknown есть, F01 ложно не устанавливает unknown; end-to-end overlap не запускался |
| B-A11 | PARTIAL | Code review deadline и пакетные tests; полной независимой матрицы нет |
| B-A12 | NOT RUN | Inherited run не достигнут; закрытые R31 не переоткрыты |
| B-A13 | FAIL | Нет успешного полного reviewer suite; отдельно описаны ошибки подготовки и ограничения среды |
| B-A14 | INCOMPLETE | Нет полного reviewer ledger; второй raw частично утрачен |
| B-A15 | PARTIAL | Source303/ZIP665/reconstruction совпали; полная функциональная приёмка отсутствует |

Изначальное подозрение о превышении emergency deadline **снято**: точное Q1B ТЗ, §8, прямо допускает отдельную конечную cleanup grace. Документированные60s +12.75s command cleanup +2s observation сами по себе не дефект. Устное сокращение «общий бюджет» не использовано для произвольного изменения утверждённого scope.

## 4. Границы и следующий шаг

Привилегированные sudo/APT/dpkg/systemd/SSH/UFW/Docker daemon/cgroups, VM/VPS, OAuth/provider/model/live calls не выполнялись. No replay, R221 fence, C13, explicit owner/cancel и R31 emergency invariants сохраняются как обязательные требования. Historical O02 не объяснён этими новыми дефектами.

Следующий prompt — `../Q1B-R1-copilot-prompt.md`: только F01/F02, доказательные tests и один final run на окончательных bytes. Reviewer не требует запускать продуктивный VPS или предоставлять credentials. Владельцу достаточно передать Copilot этот prompt и приложенный evidence, затем вернуть пять handoff-файлов. Production acceptance остаётся открытой.
