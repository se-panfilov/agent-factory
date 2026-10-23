# Agent Factory: проверка remediation Q1A-R1.1

Дата: 23 октября 2026. Репозиторий: `se-panfilov/agent-factory`.

**Проверенный master:** `b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4`.
**Code/test commit:** `c123cd3b8793dcf96ab24836feb4acfe2f3f3bf9`.
**База сравнения:** `4d536cc4917e3f6f468fe41a62e2cfb31718361c`.

**Вывод: R1.1 принят частично. Переход к R2 пока преждевременен; production admission отсутствует. Уверенность в этом выводе — 99%.** Исправления полезны и подтверждены, но четыре группы дефектов нарушают уже поставленные требования к journal/checkpoint, recovery, receipts и no-op. Это не новые требования обязательно запустить VM.

Следующий пакет: **Q1A-R1.2 — доказуемый commit и recovery, согласованные producers и безопасный no-op**. ТЗ: `../copilot-r12-task.ru.md`. Воспроизведения и логи: `agent-factory-r11-evidence-b0bc219.zip`.

## 1. Что и как проверено

- Приложенный отчёт побайтно совпадает с `../../docs/audits/remediation-q1a-r1-1-2026-10-23.md` на указанном master. SHA-256: `a5f41b641da920677c0eb9b069b7552b580ac8a9d58532ae7e05a080833e6192`.
- Diff относительно предыдущего review: 22 файла, +3303/−130. Production-код изменён в `filesystem.ts`, `state.ts`, `engine.ts`. Между code commit `c123cd3` и проверенным HEAD менялись только отчёт и evidence package.
- Отдельная рабочая копия, Node **v24.19.0**, npm **11.9.0**. `npm --prefix setup ci --ignore-scripts --no-audit --no-fund`, typecheck и полный setup test suite завершились с кодом **0**. **116 passed / 0 failed / 0 skipped**.
- Повторно выполнен приложенный Copilot probe runner: опубликованные результаты его режима `fixed` воспроизводятся.
- Независимо выполнены **четыре положительные группы и семь отрицательных сценариев**. Все семь контрпримеров ниже воспроизведены. Дополнительно исходный N07 из предыдущего сценария выполнен на новом коде, без подмены его исходных условий.
- Исходники и тесты репозитория не изменялись; рабочая копия после проверки чистая. Для S06 взяты только fixture helpers из compiled integration test в памяти отдельного процесса; используется настоящий S06 и настоящий SetupEngine.

Достоверность перечисленных результатов — 100% в пределах сохранённых fixtures и логов. Это не статистическая оценка безопасности реального VPS. Использованы temp FS, fake process/APT adapters и локальный test subprocess. Настоящие sudo/apt, systemd, SSH/firewall, Docker daemon, OAuth/model/provider, GitHub writes, VM/VPS и физический power-loss **NOT RUN**. Неизменённые Q2–Q5 компоненты не проходили здесь новый полный аудит.

## 2. Подтверждённые улучшения

| Изменение | Что подтверждено | Граница подтверждения |
|---|---|---|
| Attempt-aware journal v2 | Новая attempt не закрывается старым receipt; проверяются sequence, installation, stage/operation identity, transitions | Repository J03 и повтор его probe; это ещё не связь с state |
| S00→S01 | Plan/apply/status/resume больше не ломают собственный журнал | P01 использует настоящий S00 из default registry и настоящий S01; новый engine в том же процессе |
| S02 install/no-op | Apply/status/resume/repeat проходят, повторной установки нет | P02: настоящий S02, fake AptAdapter; refresh также покрыт repository J02 |
| Corrupt newer primary с old previous | Исходный corrupt/quarantine сценарий теперь остаётся unresolved | Повтор Copilot N06 и исходного N07 |
| Recovery не ротирует corrupt primary поверх previous | Выделен `restorePrimaryState`; точный candidate сохраняется при interrupted primary write и возобновляется | P03 и repository J06/J07; общий выбор безопасного поколения ещё ошибочен |
| Ограничение чтения | `readTextBounded` читает один descriptor максимум limit+1 bytes | P04: limit 16, фактически 17 bytes, payload 16, truncated=true; repository J08 |
| Malformed marker | JSON `null` даёт typed `recovery_marker_invalid`, exit 8 | P04; repository J08 также содержит array/scalar |
| Fault tests | J06 проверяет число сработавших отказов; J09 имеет независимый clean control | Улучшение относительно прежних проверок, проходивших без fault |

Эти изменения нужно сохранить. Возврат к permissive reader или отключение recovery barrier проблему не решает.

## 3. Остаточные дефекты

Приоритет **P1** означает блокер завершения текущего пакета. **P2** — ошибка диагностики или достоверности приёмки. Это не CVSS и не утверждение об удалённой эксплуатации либо получении root.

### R11-F01 — P1: state_hash записывается, но никогда не подтверждает checkpoint

**Факт, N01.** Настоящий engine выполняет контролируемую operation и создаёт полный v2-журнал `intent → effect → verify → checkpoint`. Сначала checkpoint hash соответствует сохранённому state. Затем primary заменяется старым валидным snapshot той же installation, журнал оставлен неизменным. `recover` возвращает **0**, `outcome=recovery_not_required`, `scope=state_consistent`. Следующий `plan` также получает **0**.

Причина: `parseEventLine` проверяет только формат 64 hex символов; `parseJournalRecords` считает attempt завершённой по переходу в `checkpoint`. Ни reader, ни `loadState` не сопоставляют hash записи с доказуемым поколением state. Значение `state_hash` после parsing не участвует в проверке согласованности.

**Риск:** смешанные поколения snapshot/journal объявляются согласованными. Это остаток прежнего R1-F02 и прямой контрпример к J04. Probe моделирует stale restore/несогласованную пару файлов; он не утверждает, что каждый обычный apply сам создаёт такую пару.

**Исправить:** сделать проверяемую связь committed generation, attempt и checkpoint. Простого `last_checkpoint_hash === hash(current_state)` недостаточно: plan, gate approval, status refresh, ошибки и следующие stages законно меняют state. Протокол должен различать такие записи и stale/unknown поколения, сохранять public schema и определять crash windows. Старые данные без доказуемой связи остаются unknown; их нельзя молча считать новым протоколом.

Источники: [запись checkpoint](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/setup/src/core/engine.ts#L1024), [парсинг hash](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/setup/src/core/state.ts#L407), [attempt state machine](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/setup/src/core/state.ts#L527), [loadState](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/setup/src/core/state.ts#L882).

### R11-F02 — P1: prepared recovery не связывает повтор с исходным candidate и может потерять unknown

**N04 и N05 начинаются с настоящего interrupted recovery.** Один injected EIO при записи primary действительно срабатывает. На диске остаётся настоящий `prepared` marker с hash candidate, previous не повреждён.

| Продолжение | Фактический результат | Требуемый результат |
|---|---|---|
| N04: previous заменён другим schema-valid snapshot той же installation; hash отличается от prepared decision | Recovery пересчитывает hash, переписывает decision, восстанавливает другой candidate; exit 0, marker удалён | Exit 8, прежняя decision и evidence сохранены |
| N05: появляется другой valid primary с `in_flight_operation=newer-unknown-effect`, не совпадающий с prepared hash | Primary перезаписан old previous, in-flight исчез, marker удалён; exit 0 | Exit 8 до перезаписи; неизвестная операция сохранена |
| N06: потерян primary с unknown legacy operation, остался old clean previous, журнал пуст | Recovery автоматически восстанавливает previous и получает 0 | Без доказательства пригодного поколения — unresolved; пустота журнала недостаточна |

В prepared branch несовпадение primary не приводит к отказу; затем `markerAllowsRestore` разрешает fallback. Перед выбором previous нет проверки его соответствия уже persisted `candidate_state_hash`. Общий `catch` также подавляет ошибки prepared continuation и переводит их в fallback. В missing-primary branch отсутствие journal/quarantine ошибочно заменяет доказательство безопасности поколения, особенно для legacy данных.

Это повреждение/смешивание recovery artifacts, а не модель «злоумышленник уже может произвольно переписать всю доверенную машину». Fail-closed recovery обязан различать такие состояния по собственным метаданным. Нынешняя защита corrupt/quarantine case полезна, но не покрывает другой valid current и missing-current uncertainty.

**Исправить:** immutable recovery decision; exact candidate binding на каждом resume; полная проверка противоречащего primary/journal/quarantine до overwrite/cleanup; отсутствие доказательства безопасного поколения означает 8. Проверенный safe recovery должен оставаться возможным, но fixture «удалили primary, значит previous безопасен» не является таким доказательством.

Источник: [prepared/fallback/restore](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/setup/src/core/engine.ts#L1434). Остаток R1-F03/F04; J05/J06/J07 закрыты не полностью.

### R11-F03 — P1: composite attempt закрывается любым непустым массивом receipts

**Факт, N02.** План содержит две операции S01. Fixture stage возвращает один receipt от **другой operation, S12 и другого resource**. Engine получает свежий `verified` от fixture observer, записывает все четыре terminal phases, очищает in-flight и возвращает **0**. Единственная проверка effect evidence — `receipts.length !== 0`.

`journalOperationId` объединяет несколько operations в composite ID. В `message` попадают их названия, но соответствие receipts плану не проверяется. Stage-wide `verified` не заменяет evidence выполнения каждой заявленной операции. В настоящей S02 refresh/simulate/install по-прежнему исполняются внутри одного `apply`, возвращающего receipt только последней operation. Таким образом несовместимость reader устранена, но обещанное «все фактические operations учтены» не доказано.

**Риск:** внутренний баг stage может превратиться в ложный committed success. Probe не доказывает обход постпроверок APT реальным злоумышленником: в нём observer намеренно контролируемый. Он показывает отсутствие обязательной защиты engine от некорректного producer.

**Исправить:** согласовать реальные execution boundaries, plan operations и проверяемые receipts. Если несколько действий являются одной настоящей атомарной operation, это должно быть явно выражено и проверено в плане/протоколе. Нельзя просто переименовать произвольный список в composite и считать одну квитанцию подтверждением всех действий. Неопределённость после частичного выполнения сохраняется; unsupported effect path блокируется до первого эффекта.

Источники: [composite ID](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/setup/src/core/engine.ts#L707), [проверка receipts](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/setup/src/core/engine.ts#L969), [S02 effects/receipt](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/setup/src/stages/system.ts#L351).

### R11-F04 — P1: no-op вызывает apply; повторная настоящая S06 ломается

**N03, core boundary.** При пустом плане engine всё равно вызывает `stage.apply`, принимает unplanned receipt, проходит verify и возвращает 0. Fixture записывает файл в temp directory; журнал содержит **0 записей**. Это проверка отсутствия запрета на effectful apply при пустом плане.

**N07, настоящая S06.** Сначала настоящая S06 настроена в temp FS с fake process adapter. Свежий `observe` возвращает `verified`, новый `plan` содержит **0 operations и 0 gates**. Настоящий SetupEngine с verified fake S05 prerequisite возвращает `plan=0`, но `apply=2 / s06_plan_preconditions_missing`. S06 ожидает preconditions из operations, которых у no-op нет. Повторный свежий plan остаётся пустым, поэтому совет «regenerate plan» не устраняет причину.

Repository test `S06 applies canonical config/image and is idempotent on second run` повторяет старый непустой plan; он не проверяет цикл «повторно observe → новый пустой plan → apply».

**Исправить:** отдельный no-op/verify-only путь с безопасными observe/verify, без вызова effectful apply и без искусственного receipt. Preserve fresh prerequisites и optional-skipped semantics. Проверить все registry stages, в том числе S06, сохранив блокировку generic S08/S14.

Источники: [безусловный apply](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/setup/src/core/engine.ts#L946), [S06 plan/apply](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/setup/src/stages/configuration.ts#L1227), [тест повторного запуска](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/setup/tests/integration/config-images.test.ts#L244).

### R11-F05 — P2: interrupted primary restore возвращает общий exit 6 и неверный next action

В N04/N05/P03 EIO на `state.json.tmp-*` оставляет prepared marker, но первая команда получает **6 / unexpected_error**, `retryable=false`, `evidence_ref=state/events.jsonl`, «retry with a fresh plan». В этой фазе требуется продолжение/диагностика recovery; новый plan блокируется marker.

`restorePrimaryState` не переводит write/fsync/rename failure в typed recovery error. J06 проверяет лишь `notEqual(exitCode, 0)`, поэтому зелёный тест совместим с неверным кодом и инструкцией. Таблица протокола отчёта обещает exit 8/retryable для recovery commit.

**Исправить:** typed phase-specific recovery outcome с корректным evidence/next action. Различать незавершённый commit, uncertain persistence и pending cleanup; не сводить всё к обычному apply retry. Сохранение evidence сейчас работает в проверенном write-failure case — это не отдельный обход barrier.

Источники: [restorePrimaryState](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/setup/src/core/state.ts#L396), [default error conversion](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/setup/src/core/errors.ts#L43).

### R11-F06 — P2: отчёт и acceptance matrix сильнее фактического evidence

1. **N07 before/after использует разные исходные условия.** `scenarioN07Baseline` содержит corrupt newer in-flight primary и quarantine failure; `scenarioN07Fixed` содержит missing primary и clean previous. Это два полезных разных теста, но не эквивалентный before/after. При запуске исходного N07 на текущем коде: quarantine fault hit=1, `recover1=8`, `recover2=8`, оба `recovery_unresolved`; cleanup fault hit=0. Это корректное сохранение unknown, а не доказательство safe restore того же случая.
2. **J11 — только lock-holder control.** Child берёт lock и ждёт `release`. Нет writer mutation на controlled durable boundary, interruption и restart. Предыдущее ТЗ прямо запрещало называть такой control полным writer/recovery race test.
3. **J01 не использует production S00**: `makeBootstrapStage` — test helper; новый engine создаётся в том же процессе. Наш P01 отдельно подтвердил настоящий S00, но полноценный cross-process lifecycle остаётся непроверенным этим тестом.
4. **J04 не проверяет stale generation после полного checkpoint**, поэтому F01 проходит мимо suite. **J02 не проверяет соответствие каждого receipt**. Количество 116 верно; вывод о всех J01…J12 PASS — нет.
5. **Неверный полный packaging SHA:** в отчёте `82b7524f0fe367fb3e66cbb8c01ba58851366350`, фактически `82b752417e3574f747694204bfef2f0b3486d035`. `c123cd3...` как code SHA указан верно. README предлагает запускать новый probe после checkout старого SHA, где файла ещё нет; нужно сохранить probe вне worktree и указать правильный cwd.

Источники: [две реализации N07](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/audit/evidence/q1a-r1-1-4d536cc/probe-r11-matrix.cjs#L633), [J11](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/setup/tests/integration/core-q1a-r1-state-recovery.test.ts#L2312), [отчёт](https://github.com/se-panfilov/agent-factory/blob/b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4/docs/audits/remediation-q1a-r1-1-2026-10-23.md).

## 4. Пересмотр J01…J12

PASS ниже ограничен фактически проверенным свойством; прохождение test с похожим названием не закрывает весь критерий.

| Критерий | Review | Основание |
|---|---|---|
| J01 | PARTIAL | Основной lifecycle исправлен; actual S00 подтверждён нами, отдельный process lifecycle отсутствует |
| J02 | PARTIAL | S02 работает, повторной установки нет; per-operation evidence не проверено/неполно |
| J03 | PASS в проверенном scope | Attempt identity и неправильные transitions/sequence отвергаются |
| J04 | FAIL | Полный checkpoint совместно со stale state принят как consistent, N01 |
| J05 | FAIL полного критерия | Corrupt/quarantine исправлен; prepared marker + newer valid current теряет unknown, N05 |
| J06 | PARTIAL | Ряд I/O boundaries и сохранение previous проверены; decision binding и error taxonomy неполны |
| J07 | PARTIAL | Exact-candidate retry/cleanup работают в fixtures; безопасность выбранного поколения в общем случае не доказана |
| J08 | PASS в проверенном scope | Bounded read и malformed marker исправлены |
| J09 | PASS для новых проверенных faults | Hit assertions и независимый clean control есть; нельзя расширять это на все crash windows |
| J10 | PARTIAL | Guard видит retained unknown, но F01/F02 позволяют ошибочно объявить evidence согласованным/снять barrier |
| J11 | PARTIAL | Только child-held lock; writer interruption/restart отсутствует |
| J12 | PASS как результат suite | 116/116 на Node 24; не подтверждение полной приёмки или production readiness |

## 5. Следующий пакет и путь до production

**Сейчас — R1.2 целиком:** сначала executable regression expectations для F01…F05, затем единый commit/recovery protocol, producer/receipt consistency и no-op; после — настоящая writer interruption/restart matrix и исправленный отчёт. Не закрывать каждую строку изолированным if без проверки положительного lifecycle.

После приёмки R1.2 прежняя последовательность сохраняется:

| Пакет | Что должно быть доказано до перехода |
|---|---|
| R2: текущая admission и binding | Plan/gates связаны с актуальными config, host, lock/release bytes, resources и prerequisites; корректная dependency policy; старые approvals не разрешают новое действие |
| R3: оставшаяся orchestration | Cancel/expiry между эффектами, truthful auth outcomes, корректный awaiting_manual exit, sanitization; незавершённое не выдаётся за success |
| Q1B | Process-tree supervision, timeout/cancel cleanup, ограниченные outputs/env и единый privileged execution boundary |
| Q2 | Безопасные sudo/root writes, SSH/firewall rollback, APT repositories/pins, Docker isolation/cleanup; AF-08/09/31 остаются существенными блокерами |
| Q3 | Реально собираемый и запускаемый offline supervised MVP, release/M0/images; реальные артефакты вместо деклараций |
| Q4 | Auth/live gates, secrets, unknown paid outcomes, backup/restore и безопасное восстановление |
| Q5 | Service/update/inference/platforms допускаются только при своих capabilities и evidence; необязательные возможности можно оставить явно blocked для MVP |
| Q6 | CI/release evidence и disposable Ubuntu 24.04 amd64 VM matrix на точной версии; затем отдельно разрешённый supervised toy live smoke |

Это порядок зависимостей, не обещание количества дней. Для первого production scope разумно сохранить **supervised, cloud-only, read-only toy runner**; unattended/service и local inference не требуются для такого MVP. Но исключение optional paths должно реально обеспечиваться admission.

Нынешние изменения почти не затрагивают privileged adapters. Они не доказывают безопасность sudo, SSH cutover или Docker isolation. До соответствующих пакетов и qualification нет основания подключать реальные credentials и запускать privileged paths на рабочем VPS.

## 6. Действия владельца

1. Передайте Copilot этот аудит, `../copilot-r12-task.ru.md` и ZIP evidence. Текст ТЗ можно целиком вставить в новый task.
2. Попросите выполнить только R1.2, затем вернуть code SHA, точные результаты acceptance и новый отчёт; не запускать VM/live и не переходить автоматически к R2.
3. После завершения передайте новый отчёт и commit на повторную проверку. Сейчас не нужно настраивать sudo, выдавать секреты, покупать VPS или вручную удалять marker/journal/state.

Самопроверка подхода: прежнее ТЗ уже требовало generation binding, сохранения unknown и no-op без effects. Следующий шаг уточняет проверяемые контрпримеры этих требований, а не расширяет scope до всех production проблем. Следует оценивать целый lifecycle и commit protocol; наличие нового поля hash и зелёного теста с нужным названием недостаточно.
