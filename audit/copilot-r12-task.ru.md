# Copilot: Q1A-R1.2 — завершить commit/recovery и no-op protocol

Ты работаешь в `se-panfilov/agent-factory`. Это исполняемое задание на исправление **R11-F01…R11-F06** из приложенного `reviews/agent-factory-r11-audit-b0bc219.ru.md`, а не запрос нового плана.

**Baseline:** `b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4`; code tree remediation R1.1 — `c123cd3b8793dcf96ab24836feb4acfe2f3f3bf9`. Если HEAD изменился, зафиксируй актуальный SHA, сравни diff и адаптируй воспроизведения, сохранив чужие изменения. Не переписывай историю и не делай reset/clean.

**Цель:** доказуемая связь execution evidence с committed state; recovery, сохраняющий неизвестные операции; строгие receipts; полноценный повторный lifecycle без effectful no-op. Приёмка R1.1 сейчас PARTIAL. Не объявляй AF-05/06/Q1A полностью закрытыми и не начинай R2/Q1B автоматически.

## 1. Разрешённый scope

Прочитай `AGENTS.md`, `docs/automation/CONTRACT.md`, предыдущий `audit/copilot-q1a-r1-journal-recovery-fix.ru.md`, текущий аудит и отчёт R1.1. Сохрани public CLI/schema/exit-code contract 1.0.0. Новая strict/versioned внутренняя metadata допустима, если определены legacy и crash semantics. Не добавляй поля в public state через cast или silent schema bypass. Реальный конфликт contract выдели отдельно; продолжай независимую работу.

Разрешены необходимые изменения core state/engine/plan, filesystem interface, stage producers, tests и docs. Это один согласованный пакет; ограничение «один старый Pxx» не запрещает исправить зависимые producer/reader файлы.

Только local deterministic tests, temp FS, fake process/network/APT adapters и безопасные локальные subprocesses. Не запускать настоящие sudo/apt/systemd/SSH/firewall/Docker daemon/OAuth/provider/model/GitHub writes и provisioning. Не ослаблять generic S08/S14 blocks, существующие owner/lock/gates, read-only diagnostics или bounded reads. Не выполнять merge/deploy/publish.

Полный process supervisor, live reconcilers и все per-effect cancel/gate checks остаются последующими пакетами. Но минимум execution protocol, необходимый для правдивого журнала каждой поддержанной operation, входит в R1.2. Unknown external effect остаётся blocked до доказуемого reconciliation.

## 2. Сначала регрессии, затем реализация

Распакуй приложенный evidence ZIP вне исходников. Прочитай README. Review scripts **assert текущий дефект**, поэтому их exit 0 не означает безопасность: перенеси сценарии в обычные regression tests с ожидаемым исправленным поведением.

Обязательные начальные воспроизведения на baseline:

| Case | Наблюдаемая ошибка | Исправленная expectation |
|---|---|---|
| N01 | Engine-generated completed v2 journal + stale valid primary: recover=0, plan=0 | Typed exit 8; нет признания consistent или нового эффекта |
| N02 | План двух ops закрывается одним чужим receipt S12/другого resource | Reject receipt, нет terminal checkpoint и очищенного unknown |
| N03 | Empty plan вызывает apply, temp effect остаётся без journal | Apply callback не вызван; safe verify/observe |
| N04 | Prepared decision после реального EIO принимает другой previous hash | Exit 8, immutable decision и snapshots сохранены |
| N05 | Prepared decision + несовпадающий primary с in-flight откатывается к previous | Exit 8 до overwrite/cleanup, in-flight сохранён |
| N06 | Missing primary + old previous + empty legacy journal автоматически считается безопасным | Unknown без generation proof остаётся blocked |
| N07 | Настоящая verified S06 → новый empty plan → engine apply=2 | No-op apply=0 при свежих postconditions; без mutating stage apply |

Отдельно зафиксируй first recovery EIO outcome: сейчас `6/unexpected_error` с инструкцией fresh plan. Нужен typed recovery outcome по фазе.

## 3. Реализуй проверяемый commit protocol

До кода опиши короткую таблицу durable artifacts, их identity/generation, commit point и действия reader/recover при crash до/после каждого durable boundary. Это рабочая часть задания, не повод остановиться на дизайне.

- `state_hash` должен участвовать в проверке пригодности поколения, а не только проходить regex. Record checksum подтверждает запись, но не согласованность журнала со snapshot.
- Свяжи installation, attempt, operation, verify evidence и committed checkpoint так, чтобы stale primary/previous и более новый complete journal не давали false consistent.
- Учти **все законные state writes**: plan, gate approve/expire, status refresh, errors, cancel-related metadata, последующие stages. Нельзя просто сравнить current целиком с последним effect checkpoint и заблокировать обычную работу после gate approval.
- Возможен внутренний ledger/manifest или другой минимальный механизм. Определи, какие bytes/hash/generation он подтверждает, как публикуется атомарно и что происходит при interrupted write/rename/fsync. Public state schema сохраняется.
- Legacy data и нынешний journal v2 без доказательства нового invariant нельзя автоматически объявить безопасными. Допускается доказуемая read-only reconciliation; отсутствие proof означает exit 8 с точным next action. Не очищать старое evidence ради миграции.
- Event history не авторизует текущие effects. Fresh checks и admission остаются обязательны. Hash не заменяет resource verification и не считается защитой от произвольной подмены всех файлов привилегированным атакующим.
- Readers ничего не чинят и не переписывают. Неизвестный эффект не replay-ится автоматически.

## 4. Сделай recovery decision неизменяемой и возобновляемой

- При первом доказуемом выборе candidate сохрани его identity/hash/generation и основания выбора до restore.
- На каждом resume сверяй **тот же** candidate с persisted decision. Если previous изменился, не пересчитывай decision молча. Верни typed 8, сохрани обе версии evidence.
- Если current уже совпадает с выбранным commit, разрешай только доказуемое продолжение cleanup после проверки остальных blockers. Если current отличается, содержит unknown или generation непонятно — не заменяй его previous.
- Не подавляй любые ошибки prepared continuation через общий catch/fallback. Различай отсутствие артефакта, mismatch, corruption, permissions и I/O failure.
- Missing primary и пустой journal не доказывают отсутствие неизвестного legacy effect. Нужна affirmative proof безопасного поколения. Честный supported recovery должен оставаться: создай fixture с proof по выбранному протоколу, затем прерывай и возобновляй его. Не заменяй реализацию глобальным запретом recovery.
- До снятия marker проверь current, previous, journal, quarantine, decision и in-flight в рамках протокола. Conflicting evidence не удаляется и не заменяется clean state.
- `restorePrimaryState` не должен портить previous. Fault на write/fsync/rename/dir-fsync/cleanup оставляет достаточное evidence для безопасного продолжения или честного unresolved.
- Ошибки persistence recovery оформляй typed exit 8 с phase/evidence и инструкцией recover/reconciliation. Не советуй свежий plan при сохраняющемся marker. Различай pending cleanup и неизвестный commit. Не обещай retryable external effect.

## 5. Согласуй операции, receipts и no-op

- Проверяй точное соответствие effect evidence разрешённой operation/attempt/stage/resource; отбрасывай missing, duplicate, foreign и unplanned receipts. Проверки делаются до terminal checkpoint; при ошибке уже начатое действие остаётся unknown.
- Разбей execution на необходимые проверяемые boundaries либо используй действительно определённую одну operation с доказуемыми postconditions. Простое `hash(sorted operation IDs)` + любой непустой receipt не подходит.
- Для нескольких фактических operations: durable intent до соответствующего эффекта, evidence после него, verify, checkpoint. После частичного выполнения журнал отражает фактический progress, а не завершение всех ops по stage success. Не дописывай выдуманные receipts задним числом.
- Настоящая S02 refresh/simulate/install должна соответствовать выбранной модели. Согласуй S00/S01 observations и все поддержанные first/last/no-op receipt producers. Составь короткую inventory таблицу остальных stages; несовместимый опасный путь блокируй до эффекта с конкретной причиной, не выдавая его за готовый.
- **Пустой или verify-only plan:** safe fresh observe/verify без вызова mutating `stage.apply`. Если между plan и execution появился drift, потребуй новый plan/gate, не добавляй скрыто действие. Preserve optional skipped behavior.
- Настоящая S06: первоначальная установка в fixture → fresh observe verified → новый plan с 0 ops → engine apply/status/resume должны работать. Старый тест с повтором исходного non-empty plan сохранить как отдельный case; он не заменяет no-op lifecycle.

## 6. Обязательная приёмка K01…K12

| ID | Сценарий | Обязательные assertions |
|---|---|---|
| K01 | Настоящий completed journal с устаревшим primary/previous; чужое или отсутствующее commit evidence | Exit 8, uncertainty сохранена, нет обычных effects |
| K02 | Положительный lifecycle и последующие plan/gate/status-refresh/error state writes | Законные generations распознаются; нет самоблокировки после metadata write |
| K03 | Crash до/после каждой commit boundary | Commit определяется доказательством, не наличием terminal слова; restart без replay unknown |
| K04 | Prepared recovery, подменённый previous и несовпадающий current с in-flight | Decision не переписана, snapshots/unknown сохранены, exit 8 |
| K05 | Missing/corrupt/quarantine primary, empty legacy journal, old previous | Неопределённое поколение не объявлено safe; исходный N07 проверен отдельно |
| K06 | Safe proven recovery + faults write/fsync/rename/dir-fsync/cleanup | Exact candidate сохранён; повтор идемпотентен или unresolved; typed exit/evidence/next action |
| K07 | Wrong operation/stage/resource/attempt, missing/duplicate/unplanned receipt | Нет terminal completion; реальные effects counted, неизвестное не снято |
| K08 | Настоящие S00→S01, S02 refresh+install+no-op, S06 fresh no-op | Positive lifecycle; каждая operation учтена; no-op не вызывает effectful apply |
| K09 | Empty/verify-only fake stage с trap в apply; optional skipped stage | Trap calls=0; правильные aggregate status/exit и read-only postchecks |
| K10 | Отдельные процессы: actual writer на durable boundary, reader/full recover, interruption/restart | IPC/barrier coordination, foreign lock respected, reads не пишут, нет lost update/reset |
| K11 | Старые guards: attempts/order, malformed marker, bounded growth, direct entrypoint unknown/cancel | Исправления R1/R1.1 сохранены; malformed/unknown не completed |
| K12 | Полный setup suite на Node 24 и проверяемая упаковка evidence | Typecheck/tests pass; code SHA/tree точный; отчёт соответствует assertions |

Для K03/K06 используй независимый fixture на каждую границу. Проверяй точный fault hit/count/path, bytes/hash generations до/после, отсутствие unwanted adapter calls и outcome повторной команды. Fault-off control должен показывать, что fault-specific assertion действительно замечает отсутствие fault. `exit != 0` недостаточно для проверки typed recovery semantics.

K10 требует writer, реально меняющего state/journal/decision и прерываемого на контролируемой границе. Child, который только держит lock и ждёт release, оставь отдельным полезным control. Не называй его completed writer/recovery race test. Для cross-process lifecycle используй actual registry implementations с injectable safe adapters; новый объект engine в том же процессе не равен новому процессу.

Никаких arbitrary sleeps как доказательства synchronization. Не удалять/ослаблять старые assertions ради green; изменения ожиданий обосновать конкретным contract/protocol переходом.

## 7. Команды, evidence и завершение

На поддерживаемом Node 24 выполни:

```bash
node --version
npm --version
npm --prefix setup ci --ignore-scripts --no-audit --no-fund
npm --prefix setup run typecheck --silent
npm --prefix setup run test --silent
```

Добавь `docs/audits/remediation-q1a-r1-2-<actual-date>.md` и воспроизводимый evidence package. Включи:

- baseline, **фактический tested code SHA или tree hash**, working-tree status, отдельную packaging identity без выдуманного self-referencing SHA;
- R11-F01…F06 и K01…K12: PASS/PARTIAL/OPEN, конкретный test/assertion/результат; отдельные code/test/qualification статусы;
- короткий protocol/commit-point document, legacy behavior, inventory stage producers, retained blockers;
- Node/npm, команды, exit codes, полный test log, machine-readable probe results и fault matrix;
- before/after **с одинаковыми исходными fixtures**. Исходный N07 теперь должен сохранять unknown; safe missing-primary recovery — другой case с отдельным ID и proof;
- рабочие команды воспроизведения на baseline: probe хранится вне старого checkout, cwd указывает на нужный build. Не ссылаться на ещё не существующий там файл;
- все real host/live/VM checks явно **NOT RUN**; ни один fake adapter success не является их qualification.

Исправь неточный packaging SHA и завышенные claims в историческом отчёте через явную correction/superseding note, не переписывая прошлые результаты как будто новые тесты выполнялись тогда.

Заверши весь разрешённый пакет и верни code SHA, результаты и оставшиеся blockers. Не останавливайся после добавления поля hash, одной happy-path проверки или нового файла отчёта. Если invariant не выполнен — ставь PARTIAL/OPEN, сохрани containment и назови точную причину. После этого остановись на review; следующий этап R2 отдельно.
