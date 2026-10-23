# agent-factory: проверка remediation и план выхода в production

Дата: 23 октября 2026. Проверенная версия: `eb187a845820aed6ef7ebafcbd2f9ac9853179a3`.

**Вывод: исправления полезны, но установка на рабочий VPS с настоящими credentials пока не готова. Следующий этап — завершить безопасность core и его приёмку.**

Подтверждённые факты ниже отделены от инженерных выводов. Проценты выражают уверенность в конкретном утверждении, а не вероятность взлома и не долю готовности проекта.

## 1. Что именно проверено

Сопоставлены исходный аудит на `7d845248e7fcd089a36afc8b395b38c7226e09e7`, изменения исходников и тестов, матрица Copilot и документ о привилегиях. На момент проверки удалённая ветка `master` указывает на `eb187a8`.

| Коммит | Содержание |
|---|---|
| `508dc8a9916d77c3662d47969e933a82a6aa1673` | Добавлены предыдущие аудит и промпт в `..` |
| `91c9899662ac8b524b874a03ce3e831cb1835d01` | Основной remediation: 37 файлов, включая матрицу исправлений |
| `eb187a845820aed6ef7ebafcbd2f9ac9853179a3` | Добавлен `../../setup/docs/privileges.md`; это последний коммит, но сам код изменён предыдущим |

Поэтому проверялся весь remediation относительно исходного аудита, а не только diff последнего коммита.

Работа выполнена в отдельной рабочей копии. Исходники проекта не изменялись. Проверки с побочными эффектами ограничены временными каталогами и fake adapters; для process/CLI использованы безопасные локальные Node subprocesses. Реальные sudo, apt, systemd, SSH/firewall, Docker daemon, OAuth, вызовы моделей, GitHub writes и VPS не запускались.

### Фактическая валидация — уверенность 100%

| Проверка | Результат | Что подтверждает |
|---|---|---|
| `npm --prefix setup ci --ignore-scripts --no-audit --no-fund` | Успешно | Зависимости setup установлены по lockfile без lifecycle scripts |
| `npm --prefix setup run typecheck --silent` | Exit 0 | TypeScript setup компилируется |
| `npm --prefix setup run test --silent` | **84 passed / 0 failed** | Существующая setup suite проходит |
| Дополнительные локальные probes | 10 отрицательных сценариев и 3 положительных проверки воспроизведены | Конкретные свойства текущего исполняемого кода, перечисленные ниже |
| Root application suite / полный release build | В этом повторном review не запускались | Зелёный результат старого аудита не переносится на новую qualification |
| Disposable VM / реальный privileged и live runtime | **NOT RUN** | Production qualification отсутствует |

Runtime локальных проверок: Node `v24.19.0`. Исходники и лог probes приложены в `agent-factory-review-evidence-eb187a8.zip`. Отрицательный probe намеренно утверждает наличие дефекта: его успешный запуск НЕ означает, что продукт прошёл приёмку.

## 2. Что действительно стало лучше

**Подтверждено исходниками и тестами — уверенность 99–100%.**

- Конфигурация передаётся через обязательный `StageContext.config`. Зависимость S05–S14 от process-local `lastConfig` удалена. Это исправляет исходную причину AF-01.
- `upsertPlanGates` сохраняет действующее одобрение для того же operation/plan, а проверки используют переданный clock. Старый сброс approval при apply исправлен.
- CLI отклоняет неизвестные и повторные параметры, пропущенные значения и некорректные enum. Отдельный CLI subprocess подтвердил `--typo → exit 2 / cli_parse_error`.
- `saveState` сначала атомарно заменяет primary и только затем пишет `.previous`. Инъекция ENOSPC при записи нового temp больше не убирает текущий `state.json`.
- Добавлена проверка nonce владельца перед release lock; cancel привязан к конкретному владельцу lock. Для plan и gate approve добавлен lock.
- Preflight читает настоящие ID/VERSION_ID ОС и использует `statfs`, а не размер directory inode. Apply требует положительного наблюдаемого postcondition.
- Supervised default расширен до S01–S07; версия CLI берётся из package metadata. `operations.backup_path` и `retention_days` действительно используются.

**Оговорка по AF-01:** тест с названием `plan and apply work across separate engine processes` создаёт два `SetupEngine` в одном Node-процессе, с fake registry. Он полезен против скрытой зависимости экземпляра, но не проверяет отдельные CLI-процессы, packaged setup, смену cwd или реальный набор S05–S07. Исправление причины принимаю; сквозную приёмку ещё нужно добавить.

Источник: [core-engine.test.ts](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/tests/integration/core-engine.test.ts#L282).

## 3. Что осталось сломано или регрессировало

P0 означает запрет эксплуатации соответствующего опасного пути до исправления; P1 — существенную ошибку поведения/развёртывания. Это инженерный приоритет, не CVSS.

### REV-01 — P0: verify сообщает success при blocked

**Факт, R01, уверенность 100%.** При заведомо неподдерживаемом хосте реальный S01 наблюдает `blocked`, но engine возвращает `exit=0`, `overall_status=ok`. Раньше engine ещё и записывал фиктивное `verified`; теперь статус стадии правильный, итог команды — нет.

В `runVerify` итог безусловно устанавливается в success; по умолчанию проверяется только S01 с prerequisites. Наличие receipts используется как условие обновления observation, хотя отсутствие receipts не должно скрывать отрицательный результат.

**Исправление:** общий reducer результатов выбранного closure: обязательный blocked/failed/drifted не совместим с exit 0; status/verify должны ясно показывать охват проверки. Verification result должен различать verified, legitimately skipped, blocked, failed, unknown. Пустой receipt не доказывает ни успех, ни провал сам по себе.

[engine.ts: runVerify](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/core/engine.ts#L652). Связь: AF-04.

### REV-02 — P1: preflight ещё не проверяет supported baseline

**Факт, R02, уверенность 100%.** Подставленный host report `Ubuntu 24.04 / arm64 / cgroup v1 / RAM=1 byte / free disk=1 byte / 1 inode` даёт `verified`. Проверка ресурсов сводится к `> 0`; cgroup version лишь выводится. C01 пока допускает первоначальную qualification только на amd64.

Кроме того, disk проверяется для `process.cwd()`, а не всех filesystem targets; Node проверяется по major, фактический lock/payload не подтверждается. Проверка `uid !== 0` также не отвергает неизвестный UID `-1`. Ограничение root в S01 не заменяет admission перед всеми mutation paths.

**Исправление:** проверять квалифицированный OS/arch/resource profile, точные pins там, где они заданы release lock, реальные target mounts и свободные ресурсы, UID/user, systemd/cgroup. Недостающий support не должен превращаться в одобряемый override gate. Числовые минимумы брать из согласованного resource profile, не выдумывать в тесте.

[preflight.ts](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/stages/preflight.ts#L91). Связь: AF-04, AF-07.

### REV-03 — P1: expired gate можно «успешно одобрить»

**Факт, R03, уверенность 100%.** `gate approve` после TTL возвращает `exit=0 / ok`, сохраняя gate как `expired`. `approveGate` не бросает ошибку для этого случая, а engine безусловно сообщает успех.

Это **не доказанный обход срока допуска**: `ensureGateApproved` всё ещё отклоняет expired approval. Ошибка — ложное подтверждение человеку/автоматизации. Поэтому AF-02 имеет статус PARTIAL, а не полный PASS.

**Исправление:** единый clock; boundary `now >= expires_at` означает отказ с корректным manual-action outcome; list, approve и apply согласованы. Отдельные тесты до, на и после TTL, без автоматического продления.

[gates.ts](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/core/gates.ts#L98). Связь: AF-02.

### REV-04 — P1: stage gates и operation gates рассогласованы

**Факт, R04, уверенность 100%.** Plan сохраняет только `operations[].gate_ids`. Gate, существующий только в `stage.required_gates`, не появляется в persisted gates. Локальный тест stage с required gate и пустым operations получил успешный plan и ноль pending gates. Такой способ объявления используется S00 для `bootstrap-required`.

**Исправление:** единая модель required approvals и external prerequisites, без разных независимых списков. Все исполняемые gated operations должны иметь однозначную связь с нужными approvals. Отсутствующий bootstrap receipt — проверяемый prerequisite, его нельзя «починить» одним одобрением gate.

[engine.ts: runPlan](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/core/engine.ts#L378). Связь: AF-02, AF-03.

### REV-05 — P0: fallback на .previous теряет последнее intent

**Факт, R05, уверенность 100%.** Последовательность: сохранить чистое состояние → сохранить состояние с in-flight mutation → повредить primary → `loadState`. Возвращается старая копия с `in_flight_operation=null`, `last_error=null`; recovery barrier не появляется.

**Логическое следствие, уверенность 97%:** после внешнего side effect такая потеря намерения может разрешить повторное действие. Реальный повтор платного вызова или системной мутации здесь не выполнялся.

**Исправление:** recovery сохраняет неопределённость, сверяет журнал и наблюдаемые эффекты, блокирует replay. `.previous` — источник восстановления, а не доказательство, что более поздней операции не было. Проверять candidate до записи поверх primary; сохранять повреждённое evidence. Нужен определённый commit/recovery protocol на всех write/fsync/rename boundaries.

[state.ts: saveState/loadState](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/core/state.ts#L129). Связь: AF-05, AF-17, AF-20.

### REV-06 — P0: quarantine не защищает от следующей инициализации

**Факт, R06, уверенность 100%.** При повреждённом primary без `.previous` первый load выдаёт `state_corrupt` и переносит файл в quarantine. Второй load создаёт чистый state; причина recovery исчезает.

**Исправление:** durable recovery-required barrier/эквивалент, который обычный load/init/apply/resume не снимают. Ошибочная или отсутствующая копия не должна превращать существующую установку в новую. Восстановление выполняется отдельным контролируемым действием с доказательствами.

[state.ts: loadState](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/core/state.ts#L209). Связь: AF-05.

### REV-07 — P1: legitimate optional skipped теперь ломает apply

**Факт, R07, уверенность 100%.** Реальный S12 при `optional_features.inference=false` наблюдает `skipped` и не выполняет mutations. Новый общий postcondition допускает только `verified`; engine возвращает `exit=10 / postcondition_not_verified`.

Это регрессия нового guard. Контракт C03 прямо разрешает optional skipped без приравнивания к verified.

**Исправление:** terminal success для отключённого optional сохраняет `skipped`; выбранный и включённый optional с failed/blocked получает 10, если обязательная часть готова; обязательный failure сохраняет свой exit code. Нельзя разрешать любой skipped без проверки selection/config/prerequisites.

[engine.ts: postcondition](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/core/engine.ts#L531), [inference.ts](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/stages/inference.ts#L979). Связь: AF-03, AF-04.

### REV-08 — P0: cancel проверяется после выполнения всех stages

**Факт, R08, уверенность 100%.** Первая fake stage пишет cancel request, привязанный к текущему lock. Вторая stage всё равно выполняется. Только после всего цикла engine возвращает 130.

Nonce binding полезен, но не обеспечивает своевременной отмены. Существующая модель также не доказывает остановку descendants и отсутствие orphan resources. Код 130 по контракту требует подтверждённого cleanup.

**Исправление:** cancellation checks до следующего effect и между operations; сигнал активному adapter/process; общий deadline на cleanup; unknown cleanup → recovery-required/8, а не 130. Emergency cancel не должен ждать lock, который удерживает отменяемая операция; для него нужен отдельный безопасный протокол.

[engine.ts: cancel](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/core/engine.ts#L549). Связь: AF-06, AF-14.

### REV-09 — P0: restore всё ещё копирует непроверенный payload через symlink

**Факт, R09, уверенность 100%.** Backup с пустым `entries` и файлом, не указанным в manifest, проходит verify. Restore копирует этот файл через destination symlink в отдельный временный каталог. `ensurePathNotSymlink` ловит собственную security exception и возвращает управление.

Это прежний AF-19, а не дефект нового backup_path. В той же проверке custom `operations.backup_path` разрешился правильно: restore использует `verified.backupPath`. Предположение о поломке custom backup path не подтвердилось и в замечания не включено.

**Исправление:** строгая целостность полного payload, confinement и запрет traversal/links/special files, проверка destination chain, restore-specific approvals и exclusive transaction. Только после этого можно считать backup защитой от потери данных. Пока public restore должен явно блокироваться.

[restore.ts](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/operations/restore.ts#L28), [backup.ts: verifyBackup](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/operations/backup.ts#L557). Связь: AF-18, AF-19, AF-20.

### REV-10 — P1: output limit signal не делает выполнение неуспешным

**Факт, R10, уверенность 100%.** Ограниченный локальный child печатает больше лимита, обрабатывает SIGTERM и завершает работу с 0. Process adapter возвращает `exitCode=0`, `outputLimitExceeded=true`, `timedOut=false`. Поиск по `../../setup/src` показывает, что новый флаг больше нигде не обрабатывается.

Кроме того, stdout/stderr сначала накапливаются в строках и лишь в конце обрезаются. Флаг не устраняет memory flood; signal только прямому child не является cleanup дерева процессов.

**Исправление:** ограничивать память при приёме chunks, единый unsuccessful outcome при overflow, учёт в каждом consumer, process-tree cancellation. Отдельно сохранить cwd, controlled stdin/TTY, env allowlist и sanitization. `LC_ALL=C` сейчас также можно переопределить через переданный env; policy должна задаваться по классу команды.

[process.ts](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/adapters/process.ts#L62). Связь: AF-14, AF-30.

## 4. Существенные ограничения, подтверждённые чтением кода

**Уверенность в перечисленном поведении 99%; полный эксплуатационный сценарий на VM не проверялся.**

1. **Нет общей транзакционной границы.** `loadState` способен писать до acquireLock. Verify/status refresh/backup/restore/auth/smoke и другие public paths не защищены тем же полным протоколом. Lock-only recover может переместить каталог с ещё не записанным owner; удаление lock не доказывает отсутствие внешних ресурсов. Нужны отдельные правила для read-only commands, writers, emergency cancel и recovery.
2. **Plan проверяется слишком слабо.** `validatePlanConsistency` сверяет config hash и собственный checksum плана. Нет полной привязки к фактическому host, release/lock bytes, owner session, observed resource set и нужным capabilities. На apply нужен повторный admission, включая допустимый DAG/profile/explicit verb. Checksum не является авторизацией и не защищает от враждебного процесса того же UID.
3. **Intent всё ещё записывается не вокруг эффекта.** Engine записывает intent всех operations, затем вызывает один `stage.apply`. При сбое нельзя уверенно установить, какая операция действительно началась. Сохранение in-flight в catch улучшает evidence, но само по себе не запрещает опасный replay при resume.
4. **Sudo boundary не исправлен.** Центрального проверяемого narrow executor пока нет, blanket запуск Node как root не должен становиться обходом отсутствующих прав. Изменения `PATH` не устраняют небезопасные root writes, доверие к user-controlled inputs и отсутствие privileged transaction. S03 всё ещё использует marker/no-op semantics для cutover/rollback. S04 всё ещё выводит cgroup enforcement из `State.Running`.
5. **CLI stubs направляют к небезопасному обходу.** `update plan/apply` возвращают blocked, но советуют generic S14 plan/apply. Этот совет нужно удалить, а запрет обхода закрепить в engine. `--release` и `--checks` парсятся, но не передаются в `CommandOptions`; пока verbs blocked, это не активный exploit, однако интерфейс не реализован.
6. **Host identity может быть фиктивной.** Новая проверка формата boot ID полезна; `machineIdHash` при ошибке чтения по-прежнему возвращает SHA-256 от `unknown-machine-id`. Формат валиден, происхождение — нет. Existing state также требует проверки фактической installation/host identity, не только schema.
7. **Документы переоценивают реализацию.** В remediation matrix `Current HEAD` всё ещё равен исходному `7d84524`. `privileges.md` утверждает общий lock для control mutations и описывает ожидаемые privileged/recovery свойства как current snapshot. Эти утверждения должны быть отмечены как implemented / blocked / planned с evidence.

Основные источники: [plan.ts](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/core/plan.ts), [lock.ts](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/core/lock.ts), [engine.ts](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/core/engine.ts), [access.ts](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/stages/access.ts), [docker.ts](https://github.com/se-panfilov/agent-factory/blob/eb187a845820aed6ef7ebafcbd2f9ac9853179a3/setup/src/adapters/docker.ts).

## 5. Скорректированная матрица AF-01…AF-31

CODE FIXED означает исправленную исходную причину на уровне исходников; это не deployment qualification. OPEN в строке неизменённого subsystem означает сохранение замечания исходного аудита, а не заявление о повторном прогоне всех его PoC.

| AF | Статус после review | Что осталось / следующий пакет |
|---|---|---|
| 01 | CODE FIXED; E2E OPEN | Явный config есть; добавить настоящие subprocess/packaged tests, Q1A/Q3 |
| 02 | PARTIAL | TTL success, stage/operation gates, binding; Q1A |
| 03 | PARTIAL | Admission/DAG/profile/plan integrity, operation journal, optional semantics; Q1A |
| 04 | PARTIAL | Verify exit/status, preflight/resources/host truth; Q1A/Q1B |
| 05 | PARTIAL | Recovery barrier, generations/journal, durability и identity; Q1A |
| 06 | PARTIAL | Все writers, cancel/cleanup/recover и races; Q1A/Q1B |
| 07 | OPEN | Central non-root admission и narrow sudo executor; Q1B/Q2 |
| 08 | OPEN | Privileged filesystem writes и ownership; Q2 |
| 09 | OPEN | Реальные S03 staging/cutover/rollback/second-session proof; Q2 |
| 10 | OPEN | Signed apt sources, реальные tested pins и clean-host install; Q2 |
| 11 | OPEN | Рабочий изолированный setup archive/provenance; Q3 |
| 12 | OPEN | Bootstrap quoting/path/receipt/locking; Q2/Q3 |
| 13 | OPEN | Совместимость installer/M0 manifest/policy/commands; Q3 |
| 14 | PARTIAL | cwd/stdin/TTY, bounded output, process tree, deadlines; Q1B |
| 15 | OPEN | Image digest/npm SRI/runtime ENTRYPOINT и фактический smoke; Q3 |
| 16 | OPEN | OAuth/network/TTY/UID/token refresh; Q4 |
| 17 | OPEN | Durable live reservation, unknown usage, no replay; Q4 |
| 18 | OPEN | Restore-specific plan/gates/transaction; Q1A containment, Q4 реализация |
| 19 | OPEN | Payload/link/traversal integrity и destination confinement; Q4 |
| 20 | PARTIAL | Config wired; WAL, quiescence, retention last-good, roundtrip; Q4 |
| 21 | OPEN | Runtime bounded output/quota/stale lock; Q3/Q4 |
| 22 | OPEN | Границы project/control/auth/work, untrusted checkout; Q3/Q4 |
| 23 | OPEN | Единый namespace ownership/labels и безопасная adoption; Q3 |
| 24 | OPEN | Service admission/paused state/rollback/M1/M2; Q5 |
| 25 | OPEN | Dedicated update transaction, rollback и unknown recovery; Q5 |
| 26 | OPEN | Настоящее inference health/model identity/evidence; Q5 |
| 27 | PARTIAL | CLI строгий, но incomplete verbs/config/status/default profile admission; Q1A/Q1B/Q5 |
| 28 | PARTIAL | Доказательные regressions, packaged E2E, реальные VM scenarios; каждый пакет + Q6 |
| 29 | OPEN | Достоверная GitHub baseline/permissions/evidence chain; Q5 |
| 30 | OPEN по security acceptance | Новый output flag не исправляет secret-safe logging/retention; Q1B/Q4 |
| 31 | OPEN | Exact Docker limits/cgroup evidence/cleanup confirmation; Q2/Q6 |

Полные требования прежнего аудита сохраняются. Эта таблица уточняет состояние после remediation и не отменяет неподробно повторённые подпункты.

## 6. План до production

**Инженерная рекомендация — уверенность 96%.** Сначала выпускать один узкий подтверждённый профиль: supervised, cloud-only, Ubuntu 24.04 amd64. Это соответствует C01/AGENTS, а не новый отказ от требуемого функционала. Не делать service, inference и platform runners prerequisite первого рабочего выпуска. Их код остаётся отдельно blocked до своей реализации и qualification.

Разделять три результата:

1. **Offline qualified:** чистая установка без credentials, настоящий packaged M0 и toy runner, проверенная изоляция и recovery. Это ещё не готовность к реальной модели.
2. **Supervised live qualified:** дополнительно owner-approved OAuth/live smoke, достоверный учёт использования, безопасная остановка, secrets и выбранная project integration.
3. **Service / inference / platforms qualified:** отдельные capabilities, application milestones, threat model и VM/live evidence для каждого включаемого расширения. Supervised credential exposure не переносится автоматически на unattended.

### Пакеты работ и критерии перехода

| Пакет | Конкретный результат | Обязательная приёмка | Зависимость |
|---|---|---|---|
| **Q1A — следующий pass** | Завершённая модель core: truthful outcomes, state/recovery barrier, lock coverage, gate lifecycle/binding, safe admission и запрет опасных обходов | Настоящие subprocess tests, fault injection, concurrency, TTL, optional skipped, no replay; все тесты следующего промпта | Текущий HEAD |
| **Q1B — процессы и host admission** | Narrow privileged-execution interface, root prohibition, trusted command/env/cwd/stdin policy, cancellation дерева процессов, bounded output; реальный supported-host preflight | Child/descendant timeout и flood, typed errors, missing identity, wrong OS/arch/mount/resources, root/no-sudo/no-TTY, HTTP retry/TLS/deadline | Принятый Q1A |
| **Q2 — системные адаптеры** | Реальные S02–S04 и bootstrap, безопасные root writes, signed repositories/pins, SSH/firewall rollback, Docker isolation | Adversarial FS fixtures + targeted disposable VM: clean apt, interruption, candidate validation, independent SSH re-login, exact Docker limits и cleanup | Q1A/Q1B; VM только для готовых участков |
| **Q3 — упакованный offline MVP** | Setup archive и M0 archive работают вне checkout; согласованы manifest/schema/policy/commands; images/npm integrity; runtime boundaries/labels | Полный install→fake toy smoke из архивов без dev node_modules и credentials; смена cwd; real Docker на VM; неизменность запрещённых ресурсов | Q1A/Q1B/Q2 для host install |
| **Q4 — эксплуатационные данные и live** | Backup/restore integrity и crash recovery, output quotas, secrets, OAuth и durable usage accounting | Restore roundtrip/fault matrix, WAL snapshot, last-good retention, symlink/traversal tests; fake provider scenarios, затем отдельный owner live smoke | Core + Q3; public restore остаётся blocked до приёмки |
| **Q5 — интеграции и расширения** | Dedicated update, проверяемая GitHub integration; service/M1/M2, inference и platforms отдельными задачами | Plan binding/release switch/rollback, exact SHA/run evidence, private auth boundaries; отдельные VM/live qualification для включённых features | Q3/Q4 и реальные app prerequisites |
| **Q6 — release qualification** | Immutable release с точными tested hashes, scope и воспроизводимым отчётом | Два clean installs на разных fresh VM + failure matrix, reboot/resume, resource exhaustion, emergency stop, restore; отдельный supervised live результат | Все обязательные для заявленного профиля критерии закрыты |

Каждый пакет — отдельный reviewable diff с regression tests. Q6 не заменяет проверки предыдущих пакетов. Принятие Q1A не закрывает AF-07/14/08–31 и не разрешает live/privileged запуск.

**Q2 — требования к sudo, которые нельзя потерять:** обычный owner запускает Node CLI; права повышаются только для allowlisted операции с точными argv и trusted inputs; никакого `sudo node`, `sudo npm`, shell из task text или broad sudoers/NOPASSWD. Root-owned staging, validation candidate перед заменой, symlink/ancestor/ownership защита, atomic replacement, сохранение recovery evidence. User-owned 0700 temp не является защитой от hostile same UID. Docker group — отдельный явный root-equivalent trust gate; Worker/Checker не получают socket. Для SSH/UFW требуется независимый re-login и доступ к recovery console до cutover.

**Q3 — требования к supply chain:** проверять реальные bytes и provenance pins, не заменять неработающий pin на `latest`; registry package integrity должен фактически проверяться установкой из lock, а image — по digest. Выполнять setup/app commands из manifest с правильным cwd. Проверить результат в изолированном архиве, где отсутствие runtime dependency не маскируется соседним checkout. CVE/license/provenance review зависимостей входит в release gate; в этом review он не выполнен.

**Q4 — последовательность:** сначала backup/restore и usage journal на fixtures, затем auth flow на fake provider, затем owner-controlled live. Не использовать непроверенный restore как rollback для первой live проверки. Не сохранять device codes/provider streams/auth в logs и артефактах; synthetic-secret tests должны проверять все выходы и retention.

**Q5 — что обязательно, а что можно отложить:** безопасный maintenance/update path нужен перед регулярными production upgrades; до его готовности update явно disabled и описана проверенная ручная процедура с backup/rollback. GitHub integration можно отложить до готового offline runner; она обязательна перед заявлением поддержки реального `anarchy-engine`. Service, inference и platform runners можно выпускать позднее отдельными профилями, сохраняя открытые AF и явные blockers. Автоматический scheduler без M1/M2 не допускается.

### Матрица сценариев, без которой release не принимается

| Область | Минимальные сценарии | Где доказывать |
|---|---|---|
| Lifecycle | Отдельные процессы plan→approve→apply→verify; second run; новый cwd; reboot→recover/resume | Local E2E + VM |
| State | Crash/ENOSPC/fsync/rename failures на каждой границе; corrupt/missing primary/previous; старый журнал; незавершённый effect | Fault-injected integration, затем VM interruptions |
| Concurrency | Plan/apply/approve/verify/backup/restore/smoke; PID reuse; partial owner; stale cancel; foreign lock/resources | Настоящие конкурирующие процессы, затем VM |
| Permissions | Ordinary owner; отсутствующий/expired sudo; root refusal; noninteractive no TTY; отдельный Docker-group re-login | Fake argv/UID + VM |
| S03 | Candidate validation; Match rules; потеря SSH/неуспешный re-login; timed rollback; reboot до подтверждения | Disposable VM с console |
| S04/runtime | Wrong CPU/memory/pids/network/image/labels; cgroup enforcement; daemon disconnect; output flood; orphan cleanup | Unit/adapters + real Docker VM |
| Artifacts | Isolated setup/app archives; bad signature/hash/SRI; missing dependency/capability; wrong commit/policy; untrusted target hooks | Offline release fixture + VM |
| Data | Hash mismatch, extra/unlisted payload, traversal, links, special files, corrupt WAL/DB, partial restore, insufficient disk, retention last-good | Temp FS + service-capable VM, где применимо |
| Auth/live | No credentials; wrong UID/modes; expiry/refresh; failed/ambiguous call; unknown usage after crash/restore; cancellation | Fake provider + один отдельный owner-approved smoke |
| Profiles | Required blocked; optional disabled/skipped; selected optional failed; service без M1/M2; stale GitHub evidence; disabled update/inference | Integration; VM для каждого заявленного профиля |

Результаты фиксируются на **точном SHA + hash архивов + config/lock/profile + версии ОС/runtime**. По одному зелёному логу нельзя квалифицировать другой release или другую архитектуру. Изменения после qualification требуют оценки затронутых сценариев и соответствующего повторного прогона.

## 7. Действия владельца

Сейчас достаточно передать Copilot `../copilot-next-core-pass.ru.md` вместе с этим отчётом и предыдущим аудитом. Работать в отдельной ветке; интеграцию GitHub, credentials, VM mutations и VPS пока отложить. Подробные короткие шаги находятся в `agent-factory-next-steps.ru.md`.

После каждого пакета принимать конкретный diff, failing-before/passing-after evidence и оставшиеся blockers. Не принимать статус PASS только по количеству тестов. Код и тесты можно продолжать до P15 без GitHub Project или запуска workflow в `anarchy-engine`.

## 8. Логические выводы и границы уверенности

- **99%:** текущую версию нельзя считать production-ready: наблюдаемые false success и state/restore defects противоречат необходимым свойствам эксплуатации.
- **97%:** исправление gate/контекста снимает ранний blocker и делает последующие небезопасные paths достижимее. Поэтому после этого remediation риск поспешного запуска выше, даже при улучшении кода.
- **96%:** завершённые небольшие пакеты с проверяемым admission эффективнее ещё одного запроса «закрыть все 31 AF за pass». Размер diff и число tests не измеряют безопасность.
- **Неизвестно:** сколько времени займёт реализация; насколько все pins доступны/актуальны; какое поведение даст полный реальный OS/provider stack. Для этого нет достаточного evidence.

Самопроверка: это проверка diff с повторной оценкой критических цепочек, а не новый полный аудит каждой неизменённой строки и не формальное доказательство отсутствия иных дефектов. Реальный sudo, cgroup enforcement, OAuth и service rollback остаются NOT RUN. Гипотеза о сломанном custom backup path проверена и отброшена. Следующее полезное доказательство — passing regression suite Q1A с реальными subprocesses и контролируемыми отказами, после чего можно оценивать следующий diff.
