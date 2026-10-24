# Agent Factory: проверка Q1A-R1.2

Дата завершения review: **24 октября 2026**, Europe/Amsterdam.

Проверенный `master`: **`13f6137e414a563f9f4e152f9145245e175a2d1b`**, `audit fixes 6`.
База: `b0bc219fbdf9fd5c7e07496c2c1d6ee4ebb1d3d4`.
Входной отчёт: `remediation-q1a-r1-2-2026-10-23.md`.

**Логический вывод, уверенность 99%: R1.2 принят частично. К R2 переходить пока рано.** Несколько прежних дефектов исправлены; появились две подтверждённые регрессии интеграции настоящих stages с engine. Кроме того, в recovery остаются обходы проверки поколения и неизвестного состояния. Результат `123 tests passed` воспроизводится, включая Node 24, но не доказывает заявленный Code PASS.

Следующий пакет — **Q1A-R1.3: согласовать все stage producers с engine и завершить общие правила admission recovery**. ТЗ: `../copilot-r13-task.ru.md`. Код воспроизведений и логи: `evidence/agent-factory-r12-evidence-13f6137.zip`.

## 1. Подтверждённые факты и границы проверки

Уверенность **100% в перечисленных локальных результатах**, в пределах конкретных fixtures и закреплённого SHA.

- Приложенный отчёт совпадает с репозиторным побайтно. SHA-256: `875778422595ef14f8bfa3c2651443004ce32f2daac5759859c370e5343d8627`.
- Между baseline и HEAD один commit: 22 файла, +2446/−232. Production-код изменён в `core/state.ts`, `core/engine.ts`, `stages/system.ts`, `stages/configuration.ts`.
- SHA-256 приложенного в репозитории ZIP совпадает с указанным в отчёте: `e7bd287a1b29d17e12f3840ab8ffe802a43dbd0c45c8918aa81f64e37218d097`.
- В отдельной чистой рабочей копии на **Node v24.19.0 / npm 11.9.0** выполнены `npm ci --ignore-scripts --no-audit --no-fund`, typecheck и полный setup suite: все команды exit **0**, **123 passed / 0 failed / 0 skipped**. Ограничение отчёта «Node 24 NOT RUN» для этой версии теперь закрыто нашим локальным прогоном. Это не квалификация релизного Node artifact, Ubuntu VM или production.
- Дополнительно выполнены **семь положительных групп**, **пять контрпримеров core/recovery** и сравнение **четырёх настоящих stages** на обеих версиях одним script. Сравнение выявило две регрессии и два прежних blocker. Отдельный положительный probe использует настоящий S06 через настоящий SetupEngine.
- Исходники репозитория не менялись; рабочая копия чистая. Fixture helpers загружались из compiled tests в память, без запуска их test callbacks и без изменений файлов продукта.

Везде использованы temp FS и fake process/APT/Docker/access/application adapters. Настоящие sudo/apt, SSH/firewall, systemd, Docker daemon, OAuth/model/provider, GitHub writes, VM/VPS, power-loss **NOT RUN**. Полностью заново не проверены неизменённые Q2–Q5 security components. Контрпримеры с потерянными/смешанными snapshots моделируют аварийное восстановление; это не утверждение, что обычный запуск сам удаляет файлы или что доказана удалённая эксплуатация.

## 2. Что действительно исправлено

| Прежнее замечание | Результат | Evidence |
|---|---|---|
| R11-F01: completed journal + stale primary принимаются как consistent | Теперь `state_generation_mismatch / 8`; manifest действительно участвует в admission | Core P01, repository K01 |
| R11-F02: prepared decision принимает изменённый previous или другой current | Оба исходных substitution case блокируются с 8; marker/current сохраняются | Core P03, три независимых fixtures |
| R11-F02: missing primary + old previous без journal proof | Прежний legacy case теперь остаётся unresolved | Core P04, repository K05 |
| R11-F03: произвольный receipt закрывает весь stage | Wrong-stage receipt отвергнут, terminal checkpoint не создан, in-flight сохранён | Core P02, repository K07 |
| R11-F04: empty plan вызывает effectful apply | Trap apply не вызывается | Core P02, repository K09 |
| R11-F04: настоящая S06 ломается на fresh no-op plan | `observe=verified`, 0 operations, direct apply и engine plan/apply получают 0 | S06 P05, repository K08 |
| R11-F05: primary restore EIO превращается в unexpected_error/6 | Typed `recovery_primary_persist_failed / 8`, затем exact-candidate retry проходит | Core P03 |
| R11-F06: child только держит lock | Новый K10 реально выполняет fake effect через engine, останавливается на barrier, получает SIGKILL; reader не пишет, recovery сохраняет unknown | Неизменённый repository K10, полный suite |
| Положительные S00/S01/S02 paths | Настоящий S00 из default registry, S01 и S02 проходят apply/status/resume; S02 repeat не переустанавливает | `r12-lifecycle-controls.jsonl` |

Последний independent lifecycle control создаёт новый engine в том же процессе; не выдаётся за отдельный процесс. K10 проверяет другую, явно указанную межпроцессную границу.

Исправления сохранять. Возвращать permissive receipts, отключать manifest или удалять неизвестное evidence ради зелёных тестов нельзя.

## 3. Оставшиеся дефекты

**P1** — блокер приёмки текущего remediation-пакета; **P2** — дефект evidence/отчётности. Это не CVSS и не утверждение об эксплуатации с получением root. Наблюдаемые результаты ниже подтверждены тестами; распространение на неисполненные реальные окружения указано отдельно.

### R12-F01 — P1: строгий engine несовместим с рядом настоящих stages

Один script запускает реальные modules и engine с fake adapters/verified prerequisites. План и gates проходят обычные публичные команды, guards не отключаются.

| Stage | Baseline `b0bc219` | Новый `13f6137` | Что успело произойти в fake adapter |
|---|---|---|---|
| S04 | apply 0, status 0 | apply 8, status 8, `stage_effect_receipt_unplanned` | Install, config merge, validation, restart, group operation, resource probe и mark-managed — каждый вызван один раз |
| S07 | apply 0, status 0 | apply 8, status 8, `stage_effect_receipt_resource_mismatch` | Fake offline execution выполнен, `s07-offline-verification.json` создан |
| S03 | apply 2 | apply 2, `plan_gate_representation_mismatch` | Effects не вызваны; это прежний blocker |
| S05 | apply 2 | apply 2, `plan_capability_mismatch` | Effects не вызваны; это прежний blocker |

**Причины двух регрессий:** S04 возвращает единственный receipt последней operation `resource-probe`, которая имеет kind `verify` и исключена из `effectOperations`. Остальные операции не имеют собственных receipts. S07 планирует resource `runner-offline-verification`, возвращает `runner-ready-offline`. Новая проверка закономерно отвергает эти producers, но делает это **после их effects**. В S04/S07 остаются in-flight и unresolved intents; последующий status блокируется. Проверка receipts полезна, интеграция не завершена.

**Прежние S03/S05 ошибки:** S03 operation gate IDs включают подтверждения console/second session/tailscale, а stage-level required gates исключают их, когда observed manual-флаги уже true. Engine требует полного представления operation gates. S05 объявляет `requiredCapabilities=[]`, но создаёт план с profile-specific capabilities. Эти расхождения существовали на baseline и не должны называться новыми регрессиями R1.2.

**Статическая inventory, не executable qualification:** несовпадающие resource IDs также остались в S03 (`access-cutover` вместо отдельных resources), S05 (`application-release`/`application-checkout` вместо `application-release-staging`), S09 (`project-checkout-and-proposals` вместо `github-project-proposals`), S10 (`systemd-service` вместо `service-layout-and-unit`). Для S09/S10 здесь не выполнялся полноценный engine flow. S08/S14 по-прежнему запрещены в generic apply; эту защиту сохранять. В S11/S12/S13 простого аналогичного расхождения resource ID при чтении соответствующих мест не обнаружено — это не полный PASS этих stages.

**Исправить:** полный producer inventory, согласованные operation/resource/gate/capability declarations и integration tests через engine. Поддержанные пути должны работать; неподдержанные опасные пути блокируются **до первого эффекта**. Нельзя убрать проверку, принять любой last receipt или изменить только текст ID без соответствующего execution evidence.

Источники: [receipt validation](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/src/core/engine.ts#L716), [S04 receipt](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/src/stages/docker.ts#L641), [S07 plan/apply](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/src/stages/verification.ts#L269), [S03 gates](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/src/stages/access.ts#L157), [S05 declarations](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/src/stages/application.ts#L333).

### R12-F02 — P1: recovery применяет разные неполные правила к разным видам evidence

Три независимых контрпримера показывают одну архитектурную проблему: часть recovery paths проверяет только выбранную веткой часть durable evidence.

**N01 — old effect checkpoint перекрывает более новую state generation.** Настоящий engine создаёт успешный checkpoint и manifest. Затем `saveState` сохраняет более новый state с `in_flight_operation`; previous теперь содержит прежний clean checkpoint, `manifest.last_state_hash` указывает на новое состояние, `last_effect_checkpoint` — на старое. После моделирования потери primary recovery получает **0**, восстанавливает старую копию и теряет unknown.

`canStartPreparedRecovery` сравнивает candidate только с `last_effect_checkpoint` и журналом. **`manifest.last_state_hash` при выборе candidate не проверяется.** Новое поле generation существует, но не доказывает, что более позднее неизвестное состояние отсутствует. В probe journal/checkpoint/manifest созданы настоящими writers, вручную успешное proof не рисовалось.

**N02 — manifest-only history считается fresh installation.** После потери primary и previous остаётся `state-commit.json`, созданный после state с in-flight, журнал пуст. `recover` сообщает **0 / fresh_installation_without_state**. Следующий `plan` получает 0, инициализирует clean state и заменяет manifest. Причина: `inspectStateEvidence`, missing-state residual checks и ранний fresh return не учитывают существование commit manifest. Metadata о прежнем состоянии исчезает из принятого решения.

**N03 — primary_restored cleanup игнорирует противоречащее quarantine evidence.** Настоящий safe recovery прерывается injected error удаления marker; остаётся `phase=primary_restored`. В fixture добавляется quarantined snapshot с неизвестной операцией. Повторный recover получает **0**, удаляет marker, не учитывая quarantine. Сам файл quarantine остаётся, но больше не препятствует признанию state consistent. Ветка `primary_restored` расположена до проверок quarantine/unsafe journal и вызывает cleanup до итогового load. При unsafe journal итоговый load может вернуть 8, но marker уже удалён; в выполненном quarantine case получается именно ложный success.

**Исправить:** единая оценка **всего** evidence для fresh detection, candidate selection, prepared resume и cleanup. Manifest должен входить в evidence inventory; latest effect checkpoint не равен latest state generation. Любое несовпадение или более новый unknown блокирует overwrite/cleanup, пока не доказано безопасное согласование. Marker source/reason/phase — описание транзакции, не самостоятельное разрешение потерять остальные artifacts.

Источники: [candidate admission](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/src/core/engine.ts#L1698), [fresh/cleanup branches](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/src/core/engine.ts#L1490), [evidence inventory](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/src/core/state.ts#L1077), [missing-state branch](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/src/core/state.ts#L1224).

### R12-F03 — P1: штатный plan делает доказуемое recovery недоступным

**N04.** На двух независимых fixtures получены одинаковые по смыслу state generations с настоящими engine-generated journal/manifest proof. Candidate совпадает с committed current; primary затем удалён для моделирования потери файла.

- Сразу `recover` → **0**.
- Сначала `plan` → **8**, записывает `reason=state_missing_with_recovery_evidence`; затем `recover` → **8 / recovery_unresolved**.

Причина: writable load с существующим журналом всегда выбирает `state_missing_with_recovery_evidence`, а `canStartPreparedRecovery` допускает только отсутствие marker или reason `state_primary_missing_previous_present`. Последняя причина loader-ом выбирается именно **без journal**, хотя recovery требует journal checkpoint. Получается несовместимость producer marker и consumer recovery.

Тестовый helper `seedProvenMissingPrimaryFixture` вручную записывает допущенный reason при уже существующем журнале, скрывая настоящий путь через loader. Кроме того, он вручную создаёт checkpoint старого candidate при более новом `last_state_hash`; такая fixture не должна автоматически считаться proof безопасного поколения — это близко к ошибке F02/N01.

**Исправить:** классифицировать marker совместно с содержимым evidence. Не добавлять blanket allow для любого reason; доказуемый safe case должен работать после обычной диагностики/неудачной mutating-команды, а противоречивый — оставаться blocked. Положительные fixtures создавать настоящими writer paths и проверять их согласованность до инъекции отказа.

Источники: [marker producer](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/src/core/state.ts#L1227), [marker consumer](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/src/core/engine.ts#L1698), [test helper](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/tests/integration/core-q1a-r1-state-recovery.test.ts#L681).

### R12-F04 — P1 для приёмки: per-operation progress по-прежнему не durable

**N05, настоящая S02 с fake AptAdapter.** Metadata refresh и simulate успешно выполнены; install бросает injected EIO. В момент входа в каждый adapter method и после отказа на диске только **три intent**, **ни одного effect receipt**. Все intents записаны заранее; все receipts должны были попасть на диск только после возврата общего `stage.apply`.

Новые S02 receipts действительно создаются по операциям, но находятся в локальном массиве. После ошибки поздней операции этот массив не возвращается. Engine по-прежнему исполняет stage целиком, затем пишет все effect/verify/checkpoint records. Поэтому фраза отчёта «per-operation intent/effect/verify/checkpoint» сильнее реализованного поведения.

В выполненном case uncertainty сохраняется и replay блокируется — **не заявляется обход безопасности или ложный completed**. Дефект в невыполненном требовании сохранять фактический progress между эффектами, что существенно для crash/recovery и цены ручного восстановления. Он был прямо включён в предыдущее ТЗ, не является новым требованием полного process supervisor.

**Исправить:** минимальный исполняемый operation boundary, на котором engine сохраняет evidence перед переходом к следующей operation. Stage-owned запись core state запрещена. Возможен callback/executor, но он должен вызываться у настоящего эффекта. Нельзя заменить это ещё одним циклом journal writes после stage success или выдуманными receipts после crash.

Источники: [предварительные intents и bulk apply](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/src/core/engine.ts#L984), [S02 receipts в памяти](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/src/stages/system.ts#L337).

### R12-F05 — P2: приёмка и отчёт не соответствуют исходным ID и покрытию

- **Перепутаны finding IDs.** Исходный R11-F02 — recovery, R11-F03 — receipts, R11-F04 — no-op, R11-F05 — typed errors, R11-F06 — evidence. В отчёте и `probe-results.json` F02 ссылается на receipts, F03 на no-op, F04 на recovery, F05 на missing primary, F06 на typed I/O. Полный PASS по этой таблице не трассируется к исходному аудиту.
- **K03 PASS не доказан:** R1-04 покрывает старые state/previous writes и append intent; J06 — несколько recovery boundaries. В этих матрицах нет нового `state-commit.json` write/fsync/rename/dir-fsync, `recordEffectCheckpoint`, всех фаз checkpoint binding и cleanup после противоречащего evidence. В R1-04 state fixtures ещё переиспользуются между boundaries.
- **Inventory пропустила S03–S05/S07/S09–S11.** Упоминание S12+ inventory-only не заменяет проверку stages обычного supervised маршрута. Standalone stage tests проходят, но не запускают новую receipt validation engine.
- **Before/after относится к старому R1.1 probe**, а не к полному набору R11 counterexamples. Его `baseline` и `fixed` modes по-прежнему имеют разные N07 fixtures. Исторический runner полезен, но не доказывает весь R1.2 и не является same-fixture сравнением N07.
- **Идентичность исходного test run ограничена:** опубликованы baseline HEAD и hash working-tree patch, но не сам patch с явным учётом index/untracked содержимого. После merge этот пробел для нашего review устранён независимым прогоном точного `13f6137`; нельзя задним числом приписывать его прежней сессии Copilot.
- Correction note к старому отчёту добавлена, но неверный полный packaging SHA там остался без конкретного исправленного значения. Это небольшой редакционный долг, не security blocker.

Положительное: число тестов 123 и checksum ZIP правдивы; Node 26 явно раскрыт, а K12 тогда честно помечен PARTIAL. Новый K10 — реальное улучшение теста, его не следует смешивать с прежним lock-only control.

Источники: [матрица отчёта](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/docs/audits/remediation-q1a-r1-2-2026-10-23.md#L48), [старые fault boundaries](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/tests/integration/core-q1a-r1-state-recovery.test.ts#L970), [J06](https://github.com/se-panfilov/agent-factory/blob/13f6137e414a563f9f4e152f9145245e175a2d1b/setup/tests/integration/core-q1a-r1-state-recovery.test.ts#L2003).

## 4. Исправленная связь со старым аудитом и K-критериями

| Исходный ID | Review | Что остаётся |
|---|---|---|
| R11-F01 | PASS для исходного stale-primary counterexample | State/manifest binding работает; отдельные recovery обходы перечислены в новом F02 |
| R11-F02 | PARTIAL | Prepared substitution/legacy case исправлены; latest-generation, manifest-only и cleanup evidence ещё неполны |
| R11-F03 | PARTIAL | Receipt matching есть; producers и durable operation boundaries не согласованы |
| R11-F04 | PASS в проверенном scope | Empty/verify-only trap и настоящая S06 исправлены |
| R11-F05 | PASS для проверенных EIO paths | Typed primary restore failure подтверждён |
| R11-F06 | PARTIAL | Настоящий interrupted writer добавлен; mapping/coverage/inventory claims нуждаются в исправлении |

| Критерий | Review | Пояснение |
|---|---|---|
| K01 | PASS для исходного stale state | Более новый manifest/current mismatch отвергается обычным load |
| K02 | PARTIAL | Базовые законные writes работают; всей заявленной generation/lifecycle matrix нет |
| K03 | PARTIAL | Новый manifest/checkpoint proof commit не покрыт полной fault matrix |
| K04 | PASS исходных substitutions | Previous/current подмена при prepared marker отвергается |
| K05 | PARTIAL | Legacy missing-primary исправлен; manifest-only history и другая newer uncertainty обходят правила |
| K06 | PARTIAL | Typed faults и retry работают; F02/F03 нарушают общую recovery acceptance |
| K07 | PARTIAL | Bad receipt отклоняется, но реальные producers и execution boundaries неполны |
| K08 | PASS перечисленных S00/S01/S02/S06 controls | Это не PASS остальных stages; S04/S07 имеют отдельные подтверждённые регрессии |
| K09 | PASS проверенных no-op/verify-only paths | Effectful apply пропускается |
| K10 | PASS проверенной interrupted-writer границы | После effect до receipt: SIGKILL, reader/recovery сохраняют unknown; не все crash phases |
| K11 | PASS прежних целевых regressions в suite | Новые commit/recovery контрпримеры остаются отдельными blockers |
| K12 | Node 24 local test PASS; evidence acceptance PARTIAL | 123/123 на Node 24 подтверждены нами; полнота отчёта и coverage требуют коррекции |

## 5. Логические выводы и дальнейший план

**Уверенность 99%:** препятствие переходу к R2 — конкретные воспроизводимые ошибки, а не отсутствие Node 24 или отказ запускать VM. R1.2 закрывает часть предыдущего списка, но Code PASS всего пакета преждевременен.

**Рекомендация, уверенность 97%:** ограниченный R1.3 в таком порядке:

1. Зафиксировать failing regressions на настоящих producers через engine, затем согласовать operation IDs/resources/gates/capabilities и durable execution boundary. Это устранит повторение ситуации «строгий reader/validator сломал другой stage».
2. Объединить оценку recovery evidence для fresh/start/resume/cleanup; отдельно проверить latest state generation и latest effect checkpoint. Исправить N01…N04, сохранив положительные controls.
3. Прогнать новый commit-manifest/checkpoint fault matrix с независимыми fixtures и настоящий writer interruption на ключевых фазах. Safe fixtures должны получаться штатными writers.
4. Обновить точный ID mapping и evidence; review завершённого пакета, затем R2.

Прежний путь до production сохраняется:

| Этап | Выходной критерий |
|---|---|
| R2 | Fresh plan/gate/resource/host/release binding и dependency admission |
| R3 / Q1B | Оставшиеся cancel/expiry/outcome/redaction гарантии, process-tree supervision, timeout/cleanup и узкая привилегированная граница |
| Q2 | Проверенные sudo/root writes, SSH/firewall rollback, signed/pinned APT, Docker isolation/enforcement/cleanup; AF-08/09/31 |
| Q3 | Запускаемый упакованный supervised offline MVP и реальный M0/release evidence |
| Q4 | Auth/live/secrets, неизвестные платные результаты, backup/restore |
| Q5 | Service/update/inference/platforms только при своих capabilities; optional features можно оставить явно blocked для MVP |
| Q6 | CI/release qualification и disposable Ubuntu 24.04 amd64 matrix, затем отдельно разрешённый supervised toy live smoke |

Scope первого релиза остаётся supervised, cloud-only, read-only toy runner. Ни одна из текущих core правок не доказывает безопасность реального sudo/SSH cutover/Docker daemon. Full production и unattended остаются более поздними критериями.

## 6. Что сделать владельцу

1. Передайте Copilot этот аудит, `../copilot-r13-task.ru.md` и ZIP evidence. Вставьте ТЗ целиком в новый task.
2. Попросите выполнить R1.3 до конца, вернуть точный code SHA и отчёт с фактическими assertions; не запускать реальные host/live paths и не переходить автоматически к R2.
3. Передайте результат на review. Сейчас не требуется выдавать credentials, настраивать sudo, запускать VM или вручную исправлять state/marker/journal. Node 24 для проверки текущего SHA уже использован здесь.

## 7. Самопроверка выводов

Слабое место этой проверки — отсутствие реальной ОС/daemon qualification и ограниченное число crash schedules; безопасность всего проекта неизвестна. Но отрицательные выводы о текущем пакете опираются на конкретные результаты, а не гипотезы. S03/S05 явно отделены от новых регрессий. N05 сохраняет uncertainty и поэтому не представлен как ложный success.

Практический вывод из повторяющихся remediation passes: число tests и наличие поля hash не должны быть основной метрикой завершения. Нужны две сквозные проверки: каждый supported stage через настоящий engine и единые правила принятия решений по полному набору recovery artifacts. Это смена способа приёмки уже поставленных требований, а не расширение scope до новой workflow-платформы.
