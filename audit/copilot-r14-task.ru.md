# Copilot: Q1A-R1.4 — устранить регрессии R1.3 и закрыть доказуемость lifecycle

Выполни этот remediation-пакет в `se-panfilov/agent-factory`. Нужны код, регрессионные тесты и проверяемый отчёт, а не только план.

**Baseline:** `3e4e07c4ec4bf5ca898025b68520c43c5d9905e3`, tree `65615c07df68047b8fb45ff6635b4c64a72352a9`. Сначала проверь реальный HEAD, diff и working tree. Если master изменился, зафиксируй новый SHA и учти изменения. Не reset/clean чужую работу, не переписывай историю.

Входы: `reviews/agent-factory-r13-audit-3e4e07c.ru.md`, `agent-factory-r13-evidence-3e4e07c.zip`, прежнее `audit/copilot-r13-task.ru.md`, текущий remediation report. **R1.3 принят частично.** Закрыть R13-F01…F06 и оставшиеся T-критерии. Не начинать R2/R3/Q1B автоматически, не объявлять AF-05/AF-06/Q1A/production закрытыми.

## 1. Границы и обязательные invariants

Прочитай `../AGENTS.md`, `docs/automation/CONTRACT.md`, оба последних аудита и соответствующие protocol docs. Сохрани contract 1.0.0, public CLI/schema/exit codes. Допустимы необходимые изменения core, внутренних execution types, stage modules, injectable adapters, tests и docs. Внутренняя versioned metadata допустима с явными правилами legacy/migration/crash recovery; не добавляй невалидируемые поля через `as any`.

Разрешена локальная validation: temp FS, fake process/APT/Docker/access/application adapters, локальные child processes с IPC. **Не выполнять** реальные sudo/apt/systemd/SSH/firewall/Docker daemon/OAuth/model/provider/GitHub writes, provisioning, VM/VPS, release publish, merge или deploy.

Не ослаблять:

- ordinary owner и root refusal;
- lock/foreign-owner checks, bounded reads и read-only diagnostics;
- gate/plan/resource binding и expiry;
- strict missing/duplicate/foreign/unplanned receipt rejection;
- запрет replay неизвестного эффекта;
- generic S08/S14 containment;
- safety checks release manifests/hashes/probes, SSH rollback, foreign/unmanaged Docker.

При реальном конфликте с нормативным contract укажи конкретное место и минимальный ADR/versioned вариант. Продолжай независимые исправления; не используй конфликт как основание объявить весь пакет закрытым. Рутинные решения принимай самостоятельно.

## 2. Зафиксировать baseline до правок

Распакуй audit evidence вне source tree. `r13-independent-probes.cjs` принимает абсолютный путь к собранному checkout. Все C01…C12 записывают фактические исходы; **exit 0 / harness_ok не означают PASS продукта**. Преврати воспроизведённые дефекты в tests с правильными ожиданиями, не сохраняй ошибочные исходы как желаемые.

Минимальная baseline-таблица:

| Case | Фактически на 3e4e07c | Требуется после R1.4 |
|---|---|---|
| C01 | Engine `plan→apply→plan`, потерян только primary; recover/retry 8, checkpoint binding удаляется | Доказуемый clean generation восстанавливается одинаково напрямую и после plan-written marker; proof не уничтожается |
| C02 | Newer unknown manifest блокируется | Сохранить exit 8 и evidence, не восстановить older clean state поверх newer unknown |
| C03 | Manifest-only не fresh | Сохранить blocker и отсутствие reset |
| C04 | Валидный primary без marker + unknown quarantine → recover 0 и next apply 0 | Block до effects; evidence сохранено |
| C05 | S02 refresh/simulate durable до install; install error оставляет unknown | Сохранить progress; расширить на настоящий отдельный interrupted writer и finalization |
| C06 | Failing S05 probe adapter не вызван; apply/status/verify 0, stage verified | Probe реально вызван; при отказе stage не verified, нет ложного checkpoint о probe |
| C07 | На clean Docker нет группы/member: prerequisite невозможно одобрить, install/group не начинаются | Разрешённый install/group этап, durable manual pause, проверенное продолжение в новой сессии |
| C08 | Ошибка private tailnet probe вызывает rollback | Сохранить rollback и запрет disarm/success |
| C09 | Prepared manifest/journal binding conflict: primary/manifest/decision меняются до exit 8 | Block до изменения evidence, immutable decision |
| C10 | Empty/verify-only не вызывает apply | Сохранить |
| C11 | После approvals изменены SSH/firewall hashes; cutover всё равно выполняется | Отказ до неразрешённых эффектов; новый reviewed plan обязателен |
| C12 | Primary-restored + quarantine уже блокируется до marker cleanup | Сохранить; synthetic proof не подменяет C01 |

Не подменяй C01 вручную нарисованным matching checkpoint. Не устраняй C04 удалением quarantine. Не устраняй C07 переименованием prerequisite в одобряемый gate. Не исправляй C11 удалением остальных drift checks.

## 3. R13-F01: вернуть freshness guard S03 без ложного drift от собственных effects

Сейчас `AccessStage.apply` больше не сравнивает одобренный `s03_observation_hash` с текущими SSH/firewall inputs. Сравнение package candidate не заменяет проверку reviewed cutover.

Реализуй:

1. Проверку исходных существенных inputs после approval и непосредственно до первого effect. Изменение SSH config, firewall rules, reviewed diff, critical manual prerequisites или ownership должно отменять возможность применения старого approval.
2. Явную модель ожидаемых изменений между operations. Собственная установка Tailscale/arming timer не должна давать ложный drift; внешнее изменение sshd/firewall между operations не должно маскироваться этим исключением. Используй подтверждённые postconditions предыдущей операции, а не произвольный флаг «мы уже в apply».
3. Сохранение console/second-session/tailnet/cutover acknowledgements, rollback arm→cutover→verify→ack→disarm. На failure/cancel до завершения не оставлять ложное successful evidence. Полную process-tree cancellation здесь не заявлять.

Тестировать через настоящий engine с настоящим AccessStage. До первого effect и между operations менять только существенные inputs, оставляя прочие prerequisites валидными. Проверять adapter call counts и отсутствие cutover на неутверждённом состоянии. Сохранить положительный engine lifecycle с неизменёнными внешними inputs и отрицательный C08.

## 4. R13-F03: согласовать S05 с пооперационным исполнением и реальными proofs

Общий early return по `checkout.deployedSourceCommit` сейчас пропускает `probe-release` после materialize. Дублирование строк resource IDs это не исправляет.

Требуется:

- Явно определить execution contract stage/engine: stage получает одну operation или исполняет orchestration через core-owned operation callback. Не оставлять неявное предположение, что `apply` всегда вызывается с полным планом, если production engine передаёт один элемент.
- No-op проверять для конкретной operation по достаточным postconditions. Commit marker подтверждает не все последующие actions.
- Обязательно вызвать и проверить offline command probes при fresh deploy. Отказ/timeout/missing command/negative result → соответствующий blocker, stage не verified, следующий зависимый stage не исполняется.
- Повторный verify/status-refresh/replan должен проверять текущую работоспособность с корректной freshness semantics, а не считать manifest marker достаточным доказательством работоспособности. Уточни, какие read-only diagnostics не запускают процессы и почему.
- Не писать `verify/checkpoint` о неисполненном probe. Привязать evidence к конкретному release/commit/content hash и выполненной operation.
- Избежать повторной extraction без необходимости. Если staged artifact используется между operations, его exact path, ownership и content proof должны быть восстановимы и перепроверены; не возвращать process-local `lastConfig`/непроверяемый cache. Если действительно нужны две extraction, явно отразить effects в плане и тестах.
- Сохранить проверку profile-specific capabilities устанавливаемого release. Не возвращать прежний stage/plan capability mismatch и не отменять manifest checks.

Обязательный regression: fake `probeCommands` возвращает false, но остальные release данные валидны. Через `SetupEngine` должен быть nonzero, `probeCalls>=1` для обязательной проверки, никакого verified S05. Положительный case проверяет реальные probe calls. Standalone whole-plan тест может остаться, но не заменяет production composition.

## 5. R13-F02: согласовать durable operation progress и final stage commit

Не откатывай R1.3 к «все intents → bulk apply → все receipts». Уже работающий C05 должен сохраниться.

Перед реализацией кратко опиши в protocol doc состояние transaction и таблицу crash points:

- operation admission / in-flight persistence;
- intent durable;
- effect выполнен, receipt ещё не durable;
- effect evidence durable;
- operation postconditions подтверждены;
- operation checkpoint и binding;
- stage-wide verify/observe;
- publication final verified state и final proof;
- последующие безопасные metadata-only updates;
- восстановление после любого partial write.

В текущем коде operation checkpoint ссылается на состояние с in-flight, а stage success затем сохраняет другой state hash. Restore удаляет checkpoint и сам создаёт recovery dead end. Нужен согласованный protocol, который различает **известный progress operation** и **доказанное завершение stage**.

Обязательные свойства:

1. Core — единственный владелец state/journal/commit metadata. Intent до effect; evidence завершённой operation durable до начала следующей.
2. `verify` record отражает фактическое подтверждение определённых postconditions, а не только совпадение operation/stage/resource строк receipt. Stage-wide verified разрешён только после всех обязательных проверок.
3. Неизвестный текущий effect сохраняется при ошибке/kill и не replay-ится. Частичный успех не превращает весь stage в verified. Не стирай in-flight только для прохождения восстановления.
4. Final clean state имеет проверяемую связь с завершёнными attempts. Последующий plan/gate metadata write не разрушает эту связь. Не обязательно требовать буквального равенства всех исторических hashes, но допустимые переходы должны иметь проверяемое доказательство.
5. `restorePrimaryState` не удаляет valid proof, необходимый последующей admission. При отсутствии достаточного proof — честный blocker **до** частичной перезаписи artifacts, где это возможно.
6. Реальное `plan→apply→plan`, потеря только primary, intact previous/manifest/journal → одинаковое доказуемое recovery напрямую и после reader/writable diagnostic marker. Повторный recover идемпотентен; adapter effects не повторяются.
7. Legacy/R1.2/R1.3 evidence получает явное поведение. Не объявляй старую unknown installation fresh и не мигрируй её путём удаления metadata.

Не решай проблему безусловным копированием `last_effect_checkpoint`, отключением generation checks, разрешением recovery по одному old snapshot или использованием только названия marker reason.

## 6. R13-F04: один полный admission decision до effects и recovery writes

Используй общий evaluator либо эквивалентный единый источник правил для primary/previous/quarantine/journal/manifest/marker/decision. Одного общего inventory с последующими несовместимыми if недостаточно.

Он должен применяться к ordinary load/admission, markerless recover, fresh install, start recovery, prepared continuation и primary_restored cleanup.

- Валидный primary не отменяет противоречивый quarantine. C04 должен блокировать recover/plan/apply, не менять доказательства и не вызывать adapters.
- Prepared marker не разрешает сначала restore, а потом сравнивать checkpoint binding. В C09 неправильный attempt/operation/stage/sequence/hash должен быть выявлен до изменений primary/previous/manifest/journal/decision.
- Immutable decision связан с exact candidate и нужной generation/proof, а не только со строкой state hash.
- Новое contradictory evidence должно блокировать cleanup до удаления marker.
- Законный предыдущий snapshot не объявлять угрозой автоматически: отличать предка, оставленного штатным writer, от конфликтующего/более нового unknown evidence по protocol proof. Не вводить guard, который ломает обычный success сразу после apply.
- Missing/malformed/foreign/unsupported manifest, access/I/O failure и journal uncertainty не означают fresh state.
- Read-only diagnostics не пишут marker, не мигрируют, не чистят и не ремонтируют artifacts. Lock-only recovery не выдаёт результат за full state reconciliation. Cancel остаётся доступным при повреждённом state.

Тесты должны сравнивать bytes/hashes primary, previous, manifest, journal и marker до/после отказа; изменения lock metadata не считать изменением state evidence. Наличие quarantine проверяй отдельно. Повтори конфликтующие cases в каждой фазе, не только `primary_restored`.

## 7. R13-F05: рабочая clean Docker installation с реальным manual resume

Решить cycle: отсутствие Docker group/member не может блокировать операции, которые должны установить Docker и включить owner в группу. При этом root-equivalent group approval обязателен, а факт новой сессии не одобряется вручную.

Требуемый маршрут:

1. План явно разделяет reviewed package/config/group изменения и действия, которым нужна активная group session.
2. Выполняются разрешённые install/config/group actions с receipt и durable progress; неизвестный эффект остаётся unknown.
3. Если нужна новая сессия, возвращается правдивый manual state и конкретный следующий шаг. Нельзя оставлять его как «неизвестный повторяемый install» или обходить запуском installer от root.
4. После обновления сессии engine повторно наблюдает реальные prerequisites, подтверждает принадлежность установки этому installation/attempt, продолжает с нужной operation и не переустанавливает уже доказанно выполненное.
5. Отказ обновить сессию/группа только в account database, но не активна у процесса → продолжение блокируется. Сигналы этих двух состояний должны различаться в fake adapter tests.
6. Unmanaged pre-existing Docker, foreign workloads/context, unsafe socket/TCP API остаются blocked. Новое исключение для собственной установки должно быть привязано к durable proof; нельзя выводить ownership только из `operation.id` и старого planned флага.

Fake clean fixture: packages отсутствуют, group отсутствует, owner не member, session membership отсутствует. Нельзя заменить её fixture с заранее готовой группой. Проверить `plan→approve→apply→manual pause→new session→resume→verify→repeat` и counts; сохранить обычный happy case из предыдущего comparison.

Если для разрешённого scope необходим внутренний manual-progress state, спроектируй его совместимо с contract, не ослабляя public schema. Полная реальная sudo/Docker qualification остаётся Q2/Q6 и здесь NOT RUN.

## 8. R13-F06: тесты, inventory и честная отчётность

Приведи inventory S00…S14 к фактическому коду: entrypoint/profile/dependency closure, operation kind/resources, реальные effects и receipts, gates/capabilities, no-op, поддержанный либо намеренно blocked route. `supported` не равно «метод существует».

В частности, generic containment S08/S14 сохранить. Если optional S09/S10/S12/S13 недоступны через текущую closure, указать конкретную причину и будущий квалифицируемый entrypoint; не обходить S08 запрет для зелёной таблицы. Обязательный supervised S00…S07 нельзя закрыть глобальным запретом.

Новые критерии U дополняют прежние K/T, а не переименовывают их:

| ID | Обязательная проверка |
|---|---|
| U01 | S03 changed inputs до effects и между operations; ноль неразрешённых cutover effects; normal own transitions и failed-tailnet rollback работают |
| U02 | Настоящий S05 через engine: successful, failing, timeout/missing probe; повторный verify; receipt не заменяет probe |
| U03 | C01 на engine-generated evidence: direct и plan-first recovery; повтор идемпотентен, final proof сохранён, effects не replay-ятся |
| U04 | S02 durable refresh/simulate перед install; late exception и отдельный interrupted writer; частичный stage не verified |
| U05 | C04/C09 и полный фазовый matrix quarantine/current/previous/journal/manifest/decision; отказ до writes/effects |
| U06 | Clean S04 без group/member → install/group → manual pause → реальная новая session evidence → resume/repeat; foreign adoption запрещён |
| U07 | Manifest и checkpoint binding write/fsync/rename/dir-fsync faults; отдельные initial, operation-binding и final-commit paths |
| U08 | Recovery decision/restore/cleanup faults и реальные child-writer barriers в новых фазах, SIGKILL/restart/readers/lock |
| U09 | Настоящие S00…S07 lifecycle controls, full inventory S00…S14 и honest blocked optional paths |
| U10 | Старые guards: missing/duplicate/foreign/unplanned receipt, stale primary/newer unknown, manifest-only, empty/verify-only/S06 no-op, root/lock/gates/read-only |
| U11 | Правильный immutable finding-ID mapping R11/R12/R13 + K/T/U, каждое PASS связано с конкретным assertion |
| U12 | Реальный Node 24, clean tested identity, полные logs, одинаковые baseline/fixed runners, воспроизводимый ZIP/checksum |

### Недостающие fault tests

Для U07 проверяй именно `state-commit.json` и вызов `recordEffectCheckpoint` (либо его документированную замену), а не только прежние state/previous writes. Write ENOSPC, fsync/rename/dir-fsync EIO; fault до и после появления нового durable artifact. Отдельные сценарии checkpoint append перед manifest binding и final stage publication. При невозможности продолжения допустим честный unresolved, но не false success, history reset или неизвестный replay.

На каждую boundary — новая fixture; exact path/phase/hit count; before/after hashes; число effects; результат следующей команды. Нужен fault-off control, который доказывает, что assertion действительно зависит от инжектированного отказа. Перестань переиспользовать уже повреждённую state fixture между R1-04 boundaries.

Для U08 сохрани K10, но добавь необходимые границы нового protocol: между завершённой operation и следующей, между checkpoint append и binding, вокруг final verified publication и recovery cleanup. Writer должен реально дойти до barrier через engine; reader не пишет; SIGKILL относится к собственному child; foreign lock соблюдается. Координация через IPC/barrier с bounded deadline, не произвольный sleep. Physical power-loss здесь NOT RUN.

Положительные recovery tests — преимущественно engine-generated evidence. Synthetic protocol tests допустимы отдельно и должны называться synthetic. Проверка только `exit != 0`, названия теста или числа tests не закрывает invariant.

## 9. Mapping без сдвига ID

Сохрани значения:

| ID | Исходный смысл |
|---|---|
| R11-F01 | stale primary / committed generation |
| R11-F02 | recovery evidence / immutable prepared decision |
| R11-F03 | receipt admission / journal execution protocol |
| R11-F04 | no-op / verify-only и S06 |
| R11-F05 | typed persistence errors |
| R11-F06 | evidence/coverage/packaging |
| R12-F01 | producer/engine alignment |
| R12-F02 | uniform recovery evidence rules |
| R12-F03 | plan-written marker блокирует proven recovery |
| R12-F04 | durable operation progress |
| R12-F05 | evidence/mapping discipline |
| R13-F01 | S03 input drift guard regression |
| R13-F02 | engine-generated checkpoint/final-state recovery regression |
| R13-F03 | S05 mandatory probes skipped |
| R13-F04 | incomplete all-evidence admission |
| R13-F05 | clean S04 group prerequisite cycle |
| R13-F06 | inaccurate tests/inventory/acceptance claims |

Напиши конкретную correction note к R1.3: перепутанные R12-F03/F04 и исторические R11 IDs, необоснованные T07/T08 PASS, S05 probeCalls=0, пределы T03/T10. Не переписывай историю как будто новые tests были выполнены раньше. Если код не закрывает критерий, оставь PARTIAL/OPEN с точной причиной.

## 10. Команды, evidence и завершение

На настоящем Node 24 сохрани полные outputs и exit codes:

```bash
node --version
npm --version
npm --prefix setup ci --ignore-scripts --no-audit --no-fund
npm --prefix setup run typecheck --silent
npm --prefix setup run test --silent
```

Baseline уже независимо проверен: Node v24.22.1, 127/127. Это не validation исправленного кода. Не имитируй требуемую версию подменой `process.versions`; отдельные unit fixtures проверки version guard допустимы.

Результаты пакета:

- Исправленный код и необходимые tests, protocol docs, stage inventory.
- `docs/audits/remediation-q1a-r1-4-<actual-date>.md`: точный tested commit/tree, baseline, changes, findings→assertions и K/T/U с PASS/PARTIAL/OPEN.
- Отдельные **code status**, **local validation**, **real-host qualification**. Последняя здесь NOT RUN.
- Один evidence ZIP: все runners, machine-readable результаты, actual fault matrix, полные Node/test logs, команды из чистого checkout, baseline/fixed сравнение одинаковых fixtures. Не требовать доступа к личной Copilot session directory или другому неуказанному архиву.
- Если тестировался working tree — достаточный patch для staged/unstaged/untracked content и воспроизводимый hash/algorithm. Предпочтительно закрепить tested code commit, а packaging metadata добавить отдельно. Не пытайся сделать self-referencing hash.
- Checksum ZIP отдельно. Ссылка на файл в репозитории и приложенный файл должны совпадать по bytes.

Не менять тесты только ради зелёного suite. Не удалять marker/journal/manifest/quarantine, чтобы пропустить blocker. Не объявлять runtime/privileged qualification выполненной по fake adapters. Заверши весь разрешённый пакет и верни точный SHA, результаты, remaining blockers и следующий шаг для human review. Не начинай следующий пакет автоматически.
