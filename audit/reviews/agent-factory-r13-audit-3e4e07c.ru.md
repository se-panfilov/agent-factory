# Agent Factory — независимая проверка Q1A-R1.3

Дата: 2026-10-24. Репозиторий: `se-panfilov/agent-factory`.

**Вердикт: R1.3 принят частично. Production и переход к R2/Q1B пока не принимать.** В новом коде есть подтверждённые улучшения, но также регрессии проверки SSH/firewall, проверки приложения и восстановления состояния. Уверенность в этом решении — **99%**, экспертная оценка, не статистическая вероятность.

Проверен **фактически опубликованный** commit `3e4e07c4ec4bf5ca898025b68520c43c5d9905e3`, Git tree `65615c07df68047b8fb45ff6635b4c64a72352a9`. Baseline — `13f6137e414a563f9f4e152f9145245e175a2d1b`. Ошибка прежнего сообщения о времени публикации учтена: выводы ниже относятся к новому SHA, а не к повторной проверке старого master.

## 1. Объём и фактическая валидация

В коммите изменены 33 файла, включая девять production TypeScript-файлов, четыре тестовых файла, документацию и evidence. Прочитаны изменения core/stages, относящиеся к ним adapters, contract, AGENTS и предыдущий аудит/ТЗ. Это review текущего remediation-пакета; оно не заменяет повторную квалификацию всех исторических AF-01…AF-31.

Приложенный `remediation-q1a-r1-3-2026-10-24.md` совпадает с версией в репозитории. Приложенный ZIP также совпадает с репозиторием; SHA256 действительно `f436818388176d813ee8fdc1b5fcea8061c20afba996004cf2b7b5bd3745baff`. Архив читается без повреждений. Его `working-tree.patch` проходит `git apply --reverse --check` на проверяемом commit: patch соответствует закоммиченным изменениям. Это заметное улучшение воспроизводимости относительно прежнего отчёта.

Независимый запуск на **Node v24.22.1 / npm 11.9.0**:

| Проверка | Результат |
|---|---|
| `npm --prefix setup ci --ignore-scripts --no-audit --no-fund` | exit 0 |
| `npm --prefix setup run typecheck --silent` | exit 0 |
| `npm --prefix setup run test --silent` | exit 0; **127 passed, 0 failed, 0 skipped** |
| Один independent runner C01…C12 на baseline и новом commit | Одинаковые сценарии, отдельные temp fixtures, результаты в JSONL |
| Настоящие S03/S04/S05/S07 через engine | Happy-path сравнение до/после, fake adapters, реальные guards/gates |
| S00/S01/S02 lifecycle и S06 no-op | Положительные controls проходят |

Исходники и тесты репозитория при аудите не менялись. Injected ProcessAdapter не исполняет реальные команды. Проверки штатного suite включают существующий K10 с локальным дочерним writer, barrier и SIGKILL. Не выполнялись real sudo/apt/systemd/SSH/firewall, Docker daemon, OAuth, model/provider calls, GitHub writes, VM/VPS и power-loss — **NOT RUN**.

`harness_ok: true` в независимых JSONL означает, что сценарий корректно выполнен и измерен, **не** что продукт прошёл приёмку. Выходы команд и счётчики нужно сравнивать с ожидаемыми результатами ниже.

## 2. Что действительно исправлено

| Прежний дефект | Независимый результат на 3e4e07c |
|---|---|
| S04 возвращал receipt, не соответствующий effect operations | Happy path: apply/status 0; шесть согласованных operations; install/merge/validate/restart/group/probe/mark-managed вызваны по одному разу |
| S07 resource mismatch после записи offline report | apply/status 0, report создан, receipt согласован |
| S03 stage/operation gate mismatch | Структурная admission проходит; happy path работает; отрицательный tailnet-probe вызывает rollback, disarm не выполняется |
| S05 capability mismatch | Структурная admission проходит; **семантическая проверка release имеет новый дефект R13-F03** |
| R12-F02: старый checkpoint скрывает newer unknown manifest | C02: recover 8, manifest/история сохранены; на baseline recover ошибочно 0 |
| R12-F02: один manifest объявляется fresh installation | C03: recover/plan 8, manifest сохранён, primary не создаётся; на baseline история сбрасывалась |
| R12-F02: cleanup игнорирует quarantine | C12: при `primary_restored` recover 8 до удаления marker; evidence сохранено. Это контроль на явно указанном synthetic writer proof |
| R12-F04: progress S02 только в памяти | C05: к входу в simulate durable evidence refresh уже записано; к install записано evidence первых двух операций. Ошибка install сохраняет unknown и блокирует recover |
| Empty/verify-only effects | C10: trap apply не вызывается; настоящая S06 также проходит |

Следовательно, откатывать весь пакет не требуется. Нужно исправить перечисленные ниже нарушения, сохранив работающие guards и durable progress.

## 3. Обязательные исправления

### R13-F01 — P1, security: S03 потерял проверку изменения одобренных SSH/firewall inputs

**Подтверждённый факт, C11.** После `plan` и штатных gate approvals меняются `ssh.configHash` и `firewall.rulesHash`, при неизменных package pin и manual prerequisites. Новый engine выполняет stage-managed diff и cutover, возвращает apply/status 0. Счётчики `stageCalls=1`, `cutoverCalls=1`.

В baseline прямой вызов настоящего stage с тем же сценарием получал `s03_observation_drifted / 4`, effects=0. Старый engine не доходил до этой проверки из-за прежнего gate mismatch; это отдельно отражено в JSONL. Новый код удалил сравнение `s03_observation_hash` полностью. Передача старого hash в `stageManagedCutover` не доказывает, что текущие inputs соответствуют reviewed diff.

**Вывод:** исправление ожидаемых изменений внутри стадии ослабило существующий security guard. Одобрение больше не связано с фактическими SSH/firewall inputs. Это нарушение contract §stage interface: повторный observe/hashes перед apply и аннулирование плана при TOCTOU drift. Реальные изменения сети и privilege escalation здесь не воспроизводились.

**Исправить:** вернуть проверку reviewed исходного состояния перед первым эффектом; для последующих операций проверять допустимые переходы с учётом уже подтверждённых собственных изменений. Нельзя просто игнорировать весь observation hash. Проверять внешнее изменение до начала и между операциями; fresh approvals нужны после изменения существенного diff. Сохранить rollback и независимый вход.

Источники: [S03 apply](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/stages/access.ts#L427), [проверка stage в engine](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/core/engine.ts#L1074), [нормативный contract](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/docs/automation/CONTRACT.md#L68).

### R13-F02 — P1: штатный writer создаёт evidence, с которым safe recovery застревает

**Подтверждённый факт, C01.** Fixture создаётся через обычные `SetupEngine.plan → apply → plan`; дополнительный plan штатно сохраняет чистое завершённое состояние в previous. Затем моделируется потеря только `state.json`. Manifest, journal и previous не подделываются.

На baseline прямой recover возвращает 0. На новом commit и прямой recover, и recover после plan-written marker возвращают 8. При этом primary уже восстановлен, `last_effect_checkpoint` удалён из manifest, marker оставлен в `primary_restored`; повторный recover снова 8.

**Причина:** engine записывает operation checkpoint с hash состояния, которое ещё содержит `in_flight_operation`. После stage verify/observe он отдельно сохраняет clean state с другим hash. `restorePrimaryState` сохраняет checkpoint только при равенстве его hash восстанавливаемому clean state, поэтому удаляет его. Затем cleanup требует совпадения journal checkpoint и manifest и закономерно блокируется. Наличие последнего operation checkpoint само по себе не является доказательством завершённого stage commit.

Штатный `seedProvenMissingPrimaryFixture` вручную создаёт event chain и вписывает checkpoint hash чистого state в manifest. Такая fixture теперь консистентна сама по себе, но **не отражает то, что пишет engine после apply**. Поэтому T07 зелёный, а реальный путь writer→recover сломан.

**Исправить:** согласовать operation progress, verified stage completion, state generation и checkpoint proof. Final verified generation должна иметь восстанавливаемое доказательство; restore должен сохранять проверенную связь, а не разрушать её. Нельзя закрыть проблему ослаблением проверки hash, копированием произвольного старого checkpoint или объявлением любого in-flight завершённым. Документировать crash windows и migration для уже созданных R1.2/R1.3 artifacts.

Источники: [operation checkpoint](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/core/engine.ts#L1163), [отдельное завершение stage](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/core/engine.ts#L1214), [restorePrimaryState](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/core/state.ts#L661), [synthetic fixture](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/tests/integration/core-q1a-r1-state-recovery.test.ts#L681).

### R13-F03 — P1: S05 объявляет release verified, не вызывая обязательные offline probes

**Подтверждённый факт, C06.** Настоящий ApplicationStage с fake adapter, у которого `probeCommands` должен вернуть оба результата false. Через настоящий engine: apply=0, status=0, verify=0, recorded S05=`verified`; `probeCalls=0`, `materializeCalls=1`, `extractCalls=2`. В journal при этом есть полный `intent/effect/verify/checkpoint` для `s05-probe-release-*`.

**Причина:** engine теперь вызывает `stage.apply` отдельно для каждой operation. После materialize следующий вызов видит checkout с нужным commit и попадает в общий early-return «already deployed», выдавая no-op receipt вместо probe. Stage-level verify проверяет manifest и commit marker, но `probeCommands` тоже не вызывает. Проверка идентификатора receipt этого не замечает.

Прямой тест `stage.apply(ctx, wholePlan)` использует snapshot до materialize и действительно вызывает probe один раз. Он не проверяет новый production execution path. Уже в приложенном Copilot `stage-compat-fixed-working-tree.jsonl` у S05 `probeCalls=0`; таблица PASS не учитывает этот результат.

**Исправить:** no-op допускается отдельно для конкретного доказанного действия, а не для всех оставшихся operations по признаку наличия commit marker. Проверка работоспособности release обязательна и после материализации, и при повторной проверке, если нет достаточного свежего evidence. Не записывать `verify/checkpoint` о probe, который не выполнен. Согласовать stage API с пооперационным engine; устранить повторную extraction либо явно обосновать и проверить оба effect boundaries.

Источники: [early return](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/stages/application.ts#L435), [probe operation](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/stages/application.ts#L549), [verify](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/stages/application.ts#L588), [standalone test](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/tests/integration/application.test.ts#L195).

### R13-F04 — P1: единая admission всего recovery evidence всё ещё не реализована

Два подтверждённых варианта:

1. **C04, marker отсутствует, primary валиден, quarantine содержит unknown той же installation.** `recover` возвращает `recovery_not_required / state_consistent / 0`; последующий plan/apply также 0. Quarantine остаётся на диске, но не запрещает обычные effects. Это существовавший обход, который обещанная унификация R1.3 не закрыла. В `loadState` quarantine учитывается при отсутствии primary; ранняя ветка recover с primary обходит cleanup evaluator. При `primary_restored` аналогичный quarantine уже корректно блокируется — C12.
2. **C09, prepared decision + конфликтующий checkpoint binding в manifest.** После реального fault при restore в manifest меняется только `last_effect_checkpoint.attempt_id` на другое schema-valid значение. Следующий recover сначала записывает primary и меняет manifest/decision, затем возвращает 8. Проверка checkpoint identity выполняется слишком поздно. Это не ложный успех и не replay, но противоречивые evidence изменены до окончательной admission.

**Исправить:** один набор правил должен применяться к ordinary load, markerless recovery, start, prepared continuation и cleanup **до** разрешения effects или записи/удаления evidence. Распознавать допустимые предыдущие поколения по доказанной связи: нельзя просто запретить всякий previous с in-flight, потому что такой previous может законно остаться после успешного writer. Противоречивый quarantine и manifest/journal binding не должны исчезать из решения из-за наличия primary или фазы marker.

Источники: [ранний recovery success](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/core/engine.ts#L1535), [prepared branch](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/core/engine.ts#L1661), [cleanup evaluator](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/core/engine.ts#L572), [loadState evidence branching](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/core/state.ts#L1233).

### R13-F05 — P1 для развёртывания: чистая S04 попадает в цикл prerequisite

**Подтверждённый факт, C07, обе версии.** Docker не установлен; группа Docker отсутствует; обычный owner ещё не её участник. Остальные adapter prerequisites удовлетворены. Plan содержит install/group operations, но также stage gate `s04-docker-group-relogin-required`. Этот gate нельзя одобрить (`gate_prerequisite_not_approvable / 5`). После одобрения остальных apply получает `gate_not_approved / 4`, `installCalls=0`, `groupCalls=0`.

**Вывод:** стадия требует результат собственного будущего действия до начала этого действия. Это прежний дефект, не новая регрессия R1.3. Happy fixture, в которой Docker отсутствует, но owner уже в группе, не покрывает обычную чистую установку. Отчёт не может на этом основании объявлять S04 supported во всех требуемых сценариях.

**Исправить:** разделить утверждённые install/config/group изменения и продолжение после реального обновления сессии. Привязать pause/resume к durable evidence выполненных операций; подтвердить ownership собственной новой установки, не разрешая adoption чужого Docker. Нельзя «исправлять» разрешением вручную одобрять relogin prerequisite или запуском всего installer через sudo/root. Проверить, что сигнал active session membership действительно относится к процессу текущей сессии, а не только к записи группы пользователя.

Источники: [relogin gate](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/stages/docker.ts#L168), [запрет approval prerequisite](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/core/gates.ts#L107), [проверка всех stage gates до effects](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/core/engine.ts#L1089), [наблюдение membership](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/adapters/docker.ts#L556).

### R13-F06 — P2: матрица PASS и tests по-прежнему сильнее фактических assertions

**Подтверждённые несоответствия:**

- IDs снова сдвинуты. Настоящий **R12-F03 — plan-written marker блокирует proven recovery**; **R12-F04 — durable operation progress**. Отчёт называет F03 durability, F04 prepared/cleanup. Исторический R11 mapping также остаётся неверным: F02=recovery, F03=receipts, F04=no-op, F05=typed errors, F06=evidence.
- T08/K03 объявлены PASS со ссылкой на прежние R1-04/J09. У них нет требуемой матрицы write/fsync/rename/dir-fsync именно для `state-commit.json` и `recordEffectCheckpoint`. T04/T05 admission assertions не заменяют I/O fault injection. R1-04 по-прежнему переиспользует одну изменяемую state fixture.
- T03 ссылается на J02 happy/repeat и K10 с fake S01 writer. Это не тест позднего сбоя настоящей S02 и не SIGKILL между её операциями. Наш C05 подтверждает улучшение при exception, но не закрывает отсутствующий process-interruption case.
- T07 положителен на ручной proof fixture, которая маскирует R13-F02. T06 проверяет только один quarantine cleanup case, не весь promised набор prepared/current/previous/journal/manifest conflicts.
- T10/K10 охватывают одну важную границу after effect / before returned receipt. Нет расширенной матрицы stage finalization и manifest binding. Уже имеющийся K10 полезен и должен сохраниться.
- Stage inventory не содержит полного обещанного перечня фактических effects/receipt semantics. S05 показывает `supported`, хотя probe отсутствует. S04 не оговаривает clean group prerequisite. S09/S10/S12/S13 также нельзя считать квалифицированными generic routes: их настоящая dependency closure включает S08, который текущий engine безусловно запрещает в generic apply. Последнее — статический вывод, не запуск optional/live stages.
- В `acceptance-mapping.json` нет отдельной K-matrix, хотя correction note обещает её machine-readable представление. В новом ZIP есть outputs и patch, но нет самостоятельного probe runner/инструкции запуска этих сравнений; прежний runner доступен через другой архив в репозитории. Для следующего review нужен один воспроизводимый пакет.

**Исправить:** тестировать production composition, а не только stage отдельно; positive recovery создавать штатным engine; перечислить фактически инжектированные границы и проверенные assertions. Исправить mapping без переименования замечаний. Честно ставить PARTIAL/OPEN/NOT RUN. Полный Node 24 запуск, число 127, приложенный patch и ZIP checksum подтверждены — их не следует объявлять недостоверными из-за других ошибок отчёта.

Источники: [report](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/docs/audits/remediation-q1a-r1-3-2026-10-24.md), [fault matrix](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/audit/evidence/q1a-r1-3-2026-10-24/fault-matrix.json), [stage inventory](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/docs/stage-inventory.md), [generic containment](https://github.com/se-panfilov/agent-factory/blob/3e4e07c4ec4bf5ca898025b68520c43c5d9905e3/setup/src/core/engine.ts#L698).

## 4. Исправленная приёмочная матрица

PASS ниже ограничен названными проверками, а не безопасностью всей подсистемы.

| Исходное замечание | Статус после R1.3 |
|---|---|
| R11-F01 — stale primary | PASS исходного guard по suite; соседние recovery paths — R13-F02/F04 |
| R11-F02 — recovery | PARTIAL |
| R11-F03 — receipt admission/protocol | PARTIAL: identity guards сохранены; S05 выдаёт receipt без probe |
| R11-F04 — no-op | PASS проверенных empty/verify-only/S06 paths |
| R11-F05 — typed errors | PASS проверенных restore/cleanup EIO, без заявления о полной I/O matrix |
| R11-F06 — evidence | PARTIAL |
| R12-F01 — producer/engine integration | PARTIAL: исходные identity mismatches исправлены, S05 и чистая S04 не завершены |
| R12-F02 — единые recovery rules | PARTIAL: C02/C03/C12 исправлены; C04/C09 остаются |
| R12-F03 — plan marker/proven recovery | PARTIAL: reason guard исправлен, engine-generated proof теперь ломается на другой границе |
| R12-F04 — durable progress | PARTIAL: C05 подтверждает запись до следующего эффекта; completion/recovery protocol и interrupted S02 matrix не завершены |
| R12-F05 — evidence/mapping | PARTIAL: Node 24 и patch есть; mapping и coverage всё ещё неверны |

| K | Статус / предел |
|---|---|
| K01 | PASS исходного stale-primary case |
| K02 | PARTIAL: generation lifecycle имеет R13-F02 |
| K03 | PARTIAL: manifest/checkpoint I/O boundaries не покрыты требуемой матрицей |
| K04 | PASS исходных previous/current substitutions; новый prepared proof conflict — R13-F04 |
| K05 | PASS исходного legacy missing-primary blocker и проверенного manifest-only family |
| K06 | PARTIAL: typed errors есть, recovery end-to-end нарушен |
| K07 | PARTIAL: strict identity admission есть, semantic producer evidence неполно |
| K08 | PASS проверенных S00/S01/S02/S06 controls |
| K09 | PASS empty/verify-only traps |
| K10 | PASS существующей одной interrupted-writer границы |
| K11 | PASS сохранённых целевых regressions в suite; новые случаи перечислены отдельно |
| K12 | Local Node 24 PASS; evidence/acceptance PARTIAL |

| T | Независимый статус / основание |
|---|---|
| T01 | PASS ограниченного S04/S07 happy comparison, не full clean-host qualification |
| T02 | PARTIAL: structural fixes есть; S03 drift guard удалён, S05 probe пропущен, inventory завышена |
| T03 | PARTIAL: exception path S02 улучшен; нужного отдельного process interruption S02 нет |
| T04 | PASS исходного newer unknown manifest case |
| T05 | PARTIAL полного набора: manifest-only/malformed/foreign проверены; явного unsupported-version test в добавленном T05 нет |
| T06 | PARTIAL: cleanup/quarantine исправлен, prepared binding conflict всё ещё меняет artifacts |
| T07 | OPEN для engine-generated safe recovery; synthetic positive не закрывает C01 |
| T08 | OPEN требуемой новой manifest/checkpoint fault matrix |
| T09 | PARTIAL: отдельные fault cases полезны, реальный protocol recovery ещё broken |
| T10 | PARTIAL: один настоящий writer/SIGKILL case, не новые operation/finalization phases |
| T11 | PASS проверенных controls; весь S05 semantic path сюда не включён |
| T12 | Local commands PASS; mapping/reproducible runner/acceptance PARTIAL |

## 5. План до production

1. **Q1A-R1.4, ближайший ограниченный пакет:** исправить R13-F01…F06; согласовать operation execution и final completion; закрыть C01/C04/C06/C07/C09/C11; добавить недостающие T03/T06/T07/T08/T09/T10 tests. Перепроверить реальную composition S00…S07. Готовое задание — `../copilot-r14-task.ru.md`.
2. **R2/R3 и Q1B после приёмки R1.4:** полный fresh admission и binding плана, lifecycle cancel/expiry, правдивые outcomes/redaction, process supervisor с ограничениями времени/output/process tree. Новый per-operation цикл ещё не доказывает per-effect expiry внутри операций; это отдельная работа.
3. **Q2, привилегированные boundaries:** закрыть исторические AF-08/09/31 и актуальные пункты privileged audit. Обычный owner, фиксированные argv, безопасные root-owned temporary writes/canonical paths/symlinks, реальный rollback SSH/firewall, Docker ownership/session/изоляция, корректные APT failure/reboot/relogin paths. Никакого общего root installer, NOPASSWD-all или обхода gates.
4. **Q3/Q4:** квалифицировать reviewed M0 release и минимальный supervised/cloud-only/read-only toy path. Затем secrets/OAuth и отдельные owner-approved live действия, неизвестные исходы платных вызовов, backup/restore. Локальная проверка release должна предшествовать credentials.
5. **Q5:** service/unattended, updates, local inference и platform runners — отдельные optional пакеты; не делать их обязательными для первого supervised production scope. Inventory должна честно описывать закрытые entrypoints и зависимости.
6. **Q6:** exact release SHA, CI/evidence и disposable Ubuntu 24.04 amd64 qualification: clean install, second run, reboot/relogin, network/disk faults, dpkg interruption, gate denial/expiry, cancellation, rollback и restore. Только затем решение о production. Первую live smoke проводить отдельным owner run с соответствующими gates.

Последовательность важна: VM не исправляет ложные локальные proofs, а passing unit suite не заменяет реальную sudo/systemd/network qualification. Сейчас можно продолжать локальные tests и подготовку harness; подключать реальные credentials/боевой VPS для проверки этого пакета не требуется.

## 6. Действия владельца

1. Передать Copilot этот аудит, `../copilot-r14-task.ru.md` и `agent-factory-r13-evidence-3e4e07c.zip`.
2. Поручить выполнить именно R1.4, сохранить guards, прогнать Node 24 и вернуть точный tested SHA, полный log, evidence и честную матрицу.
3. После публикации прислать **фактический commit SHA**, отчёт и ZIP/checksum. Сначала проверяется совпадение source identity; потом новая приёмка.

Дополнительные серверы, sudo-доступ или credentials от владельца на этом этапе не нужны. Полное ТЗ уже конкретизировано; отдельного подтверждения на подготовку файлов не требуется.

## 7. Пределы вывода и самопроверка

Подтверждены наблюдаемые результаты локальных fake-adapter сценариев и конкретные source-level причины. Вывод о недопустимости production основан на нарушенных обязательных invariants; он не является утверждением, что любая установка обязательно завершится аварией. Уверенность в воспроизведённых дефектах — 99%; поведение реальной ОС/daemon остаётся неизвестным до отдельной квалификации.

Наиболее важная поправка к методу: положительные stage tests и synthetic recovery proofs недостаточны. В этой проверке C01 строит состояние обычным engine, C06 проверяет engine вместе с настоящим stage, C11 сохраняет настоящие gates. C12 намеренно synthetic и используется только для проверки конкретной cleanup ветки. Прежний Docker prerequisite defect явно отделён от новых регрессий. В первых черновых запусках runner ошибочно ожидал, что любой gate можно одобрить; окончательный C07 фиксирует отказ как результат, без обхода защиты. Черновые логи сохранены в evidence с пояснением.
