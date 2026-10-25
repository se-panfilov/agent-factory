# Agent Factory — независимая проверка Q1A-R2.1

Дата: 25 октября 2026, Europe/Amsterdam. Репозиторий: `se-panfilov/agent-factory`.

**Вердикт: R2.1 PARTIAL; production OPEN.** Исходные R2-F01 и R2-F02 закрыты в проверенном локальном scope. Однако A21-08 — продолжение подтверждённого частичного выполнения без повторения effects — не выполнен для S03. Найдены два связанных, воспроизводимых пробела: ложный drift при `resume` и повтор уже выполненных операций после явного нового `plan`. Следующая задача — **Q1A-R2.1.1**, затем отдельная проверка и R2.2.

Подтверждённые результаты ниже имеют уверенность **99%** в пределах зафиксированного кода и fixtures. Вывод о неприёмке всего R2.1 — **99%**: один из обязательных критериев имеет воспроизводимые отрицательные результаты. Это не утверждение, что был выполнен реальный SSH cutover или обход системного sudo.

## 1. Проверенная версия и соответствие вложений

| Объект | Фактическая идентичность |
|---|---|
| Проверенный `master` | `d8728f56e847a9da75b9f21d8e6e6725a9bd295e` — `audit fixes 10` |
| Tree | `445baea7169ddfb572d1638caad9ef1b38272781` |
| База пакета | `ca6d0b6f2a75f3c97a80468bbc2bdcbe2db7a4ff` |
| Tree базы | `9a0f861b71ebce4df8c56850dcf6c6764e1082a4` |
| Предыдущая принятая R1.6 | `5fde93d2c470171039698c35478c020085ef66ff` |
| Входной evidence ZIP SHA-256 | `2c6b521eb2116fb4a50610d007faff349d4df9862df6a786657f9f1f92a0ad21` |
| Полный patch SHA-256 | `1abd4c0fd235ebe0d215da171bb57aeecde4c2de0bc85bf1fce2e57a5b066b67` |
| Tested manifest SHA-256 | `75973014385506fd0228e64c4d0165effdb38b267c3c94f2aa3c20ae4685ae8c` — 143 файла |

Все пять приложенных файлов byte-for-byte совпадают с опубликованным пакетом `../evidence/q1a-r2-1-2026-10-25-local`. Проверены ZIP CRC, 161 внутренняя checksum, все 143 entries manifest, точное покрытие им tracked `setup/`, а также отдельные new-file hashes. База + полный patch действительно восстановлены в пустую обычную временную копию. Все 143 файла совпадают с master и остались неизменны после тестирования. Additions уже входят в patch; повторно накладывать `new-files.tar` не нужно.

`ca6d0b6` отличается от `5fde93d` только четырьмя предыдущими audit-артефактами. Production baseline R1.6 применим. Отчёт Copilot описывает состояние до публикации владельцем; последующее появление коммита в master не доказывает нарушения агентом запрета на коммиты.

Проверяющий не изменял product source, не создавал веток/worktree/PR и не выполнял commit/push/deploy. Тестирование велось в отдельных снимках; исходная рабочая копия и её посторонний untracked файл сохранены.

## 2. Что исправлено и независимо подтверждено

| Проверка | Результат |
|---|---|
| `npm --prefix setup ci --ignore-scripts --no-audit --no-fund` | exit 0, отдельный снимок master |
| `npm --prefix setup run typecheck --silent` | exit 0 |
| `npm --prefix setup run test --silent` | **429 passed / 0 failed / 0 skipped** |
| Исходный R2 runner, без изменения oracle | Base: **5 safe / 3 unsafe**; master: **8 safe / 0 unsafe** |
| Старые frozen comparisons | **33 assertions PASS** |
| Старый R1.6 command checker | **37 assertions PASS**, включая один агрегат предыдущих 33 |
| R2 checker | **39 assertions PASS**, включая harness/aggregate checks; это не 39 уникальных сценариев |
| Дополнительная матрица S03 этого review | **3 / 13 desired outcomes PASS; 10 FAIL** на master |

Среда reviewer: Node **v24.22.1**, npm **11.9.0**, Linux x86_64, UID **0**. Ordinary-owner admission моделируется injected ProcessAdapter UID 1000. Это не тест установки под root и не квалификация Ubuntu VPS. Среда Copilot была другой: macOS arm64 / Node v24.12.0 / UID 501; её результаты не выдаются за наши.

Действительно закрыто:

- **R2-F01:** удаление обоих списков gates и пересчёт self-hash больше не разрешают S02 effects: exit 2 `plan_policy_mismatch`, refresh/simulate/install = `0/0/0`. Корректный одобренный S02 выполняется `1/1/1`; отсутствие одобрений по-прежнему блокируется.
- **R2-F02:** gate-free plan старше 30 минут блокируется с exit 4 `plan_expired`; дата создания в будущем — exit 8 `plan_from_future`, effects = 0. Проверены граничные времена и некорректные даты.
- Producer policy проверяется независимо от submitted JSON; per-operation поля, порядок, stage-only gates и optional/capabilities не могут произвольно изменяться самими данными плана.
- Добавлены post-lock проверки config/plan, повторная admission перед очередным effect и сохранение подтверждённого checkpoint при истечении TTL между операциями.
- `resume` перестал неявно генерировать новый план и продлевать его пригодность.
- R1.6 command identity, прежние state/journal integrity и fault/crash проверки сохранены. Приёмка R1.6 и закрытие R15-F01 остаются в силе.

В полном suite сохранены прежние 397 тестов; добавлены 32. Старые тесты не удалены и не переименованы. Успех этих тестов не закрывает отсутствующие сценарии.

## 3. R21-F01 — S03 не восстанавливает контекст подтверждённого предшественника

**P1, OPEN. Факт, уверенность 99%.** Это невыполненная часть A21-08 и заявленного свойства R2.1, а не повтор исходного обхода gates.

Воспроизведение использует настоящий `SetupEngine`, настоящий `createAccessStage`, обычные plan/approve/apply/resume и продуктовый `requestCancel`. Подставной AccessAdapter меняет только счётчики и observation в памяти. State/journal/manifest не подделываются. При каждом продолжении создаются новые engine и stage instances.

1. Сгенерировать S03 plan, одобрить его gates.
2. Запросить отмену во время выбранного fake effect. Engine завершает verify/checkpoint, фиксирует receipt и потребляет отмену на безопасной границе: exit **130**, `in_flight_operation=null`.
3. До истечения plan/gate TTL вызвать `resume`, не меняя внешние факты.
4. Получить exit **4**, `s03_observation_drifted`, без выполнения оставшейся операции. Состояние и evidence при этом сохраняются — отказ не разрушительный, но продолжение невозможно.

Причина в коде:

- `setup/src/core/engine.ts:1132–1143` восстанавливает `completedOperationReceipts`, но не восстанавливает `previousOperationReceipt` перед первой admission оставшейся операции. Аналогичный новый context создаётся в `1165–1167`.
- `setup/src/stages/access.ts:443–451` берёт expected hash из `ctx.previousOperationReceipt`, иначе из исходного plan. `494–499` повторяет ту же проверку внутри apply.
- В пределах одного запуска core устанавливает previous receipt только после effect (`engine.ts:1305`). При новом запуске это значение отсутствует; собственные уже подтверждённые изменения сравниваются с исходным состоянием до их выполнения.

| Последний подтверждённый шаг перед отменой | `resume` на master | Модель rollback timer |
|---|---|---|
| install Tailscale | exit 4, false drift | не включён |
| stage managed diff | exit 4, false drift | не включён |
| arm rollback | exit 4, false drift | включён |
| cutover | exit 4, false drift | включён |
| verify tailnet | exit 4, false drift | включён; disarm не выполняется |
| disarm, все операции уже закончены — control | exit 0, без replay | выключен |

Во всех пяти отрицательных same-plan cases hashes `state.json`, previous, manifest, journal и recovery marker до/после отказа совпадают. Completed receipts реально существуют, новый target intent не добавляется. Значит это не unknown-effect recovery и не отсутствие доказательства checkpoint.

На предыдущем baseline те же partial `resume` тоже не завершались, но по другой причине: старый resume неявно создавал другой plan и возвращал `gate_not_approved`. Поэтому нельзя называть весь дефект новым регрессом относительно прежде работавшего resume. **Новая R2.1 логика не выполнила обещанное продолжение старого reviewed plan.**

Исправление: восстанавливать контекст допустимого предшественника из проверенного durable evidence с привязкой к stage/config/операции/порядку и текущим postconditions. Нельзя доверять произвольному «последнему receipt», отключать drift checks или принимать любую похожую observation.

## 4. R21-F02 — явный новый plan теряет известное завершение S03 и повторяет effects

**P1, OPEN. Факт, уверенность 99%.** Наблюдалось и на baseline; R2.1 не устранил этот пробел A21-08.

После той же подтверждённой отмены выполняются явные `plan` → одобрение новых gates → `resume`. На master получается exit **0**, но уже завершённые операции повторяются.

| Отмена после | Суммарные вызовы install / stage / arm / cutover / tailnet / disarm после нового review |
|---|---|
| install | **2** / 1 / 1 / 1 / 1 / 1 |
| stage | **2 / 2** / 1 / 1 / 1 / 1 |
| arm | **2 / 2 / 2** / 1 / 1 / 1 |
| cutover | **2 / 2 / 2 / 2** / 1 / 1 |
| tailnet | **2 / 2 / 2 / 2 / 2** / 1 |

Control без отмены и оба продолжения после уже выполненного disarm дают ровно `1/1/1/1/1/1`. Итоговый зелёный статус сам по себе скрывает replay; нужны счётчики effects.

Причина:

- S03 включает hash всей observation в каждый operation ID (`access.ts:88–90`, `298–301`). Свои install/arm/cutover меняют observation, следовательно — IDs всех операций следующего плана.
- S03 producer не выделяет remaining sequence по доказанному завершению: для незавершённого stage возвращает полный каталог (`access.ts:350–440`).
- Re-plan enrollment сопоставляет старые/новые operations и receipts по точному ID и полной сериализации (`engine.ts:1035–1053`). После законного собственного изменения exact match не находится.
- Узкий `reconcilePolicyOperation` используется в continuing/completion policy, но не устраняет потерю identity при переносе progress в новый review.

Повтор высокорисковых действий — особенно arm/cutover — нельзя считать нормальным решением проблемы возобновления. Новый review разрешает оставшуюся работу; при неизменных требованиях и подтверждённых postconditions он не должен повторять уже известный эффект.

Исправление: согласованная модель стабильной смысловой identity и переноса подтверждённого завершения в новый plan. Сопоставления только по префиксу строки или resource ID недостаточно. Проверять полную security policy и допустимые собственные transitions; изменившиеся требования требуют нового review, а неизвестный эффект остаётся blocker. Обратить внимание: arm/disarm используют один resource ID; receipt для другого действия не является доказательством нужного предшественника.

## 5. Почему отчёт PASS оказался слишком широким

R2.1 тестирует durable progress на synthetic counter и S02, отдельные процессы также используют S02. Старые S03 tests проверяют непрерывный проход и drift/failure, но не отмену на каждом подтверждённом checkpoint с новым S03 instance и новым review.

Таким образом, подтверждены отдельные положительные сценарии A21-08, но не весь критерий. Сохранение старых 397 тестов и 429/429 не доказывает корректность новых пересечений: **stage × checkpoint × resume/re-plan × approvals × current postconditions**.

| Требование предыдущего промпта | Независимый статус |
|---|---|
| A21-01…06 | PASS в проверенном local scope |
| A21-07 | PASS local для предусмотренных closure/containment/composition fixtures |
| **A21-08** | **PARTIAL: S03 counterexamples R21-F01/F02** |
| A21-09…13 | PASS для предоставленных time/lock/drift/expiry cases; общего доказательства всех concurrency сценариев нет |
| A21-14 | PASS как regression/evidence checks, не как доказательство отсутствия иных дефектов |
| R2-F01 / R2-F02 | CLOSED local |
| R1.6 / R15-F01 | Прежняя local приёмка сохранена |
| Весь R2.1 | **PARTIAL** |

Замечание по качеству, **P2 / сопутствующее**: новый security-critical `policy.ts` и существенная часть enrollment/admission/test logic написаны очень плотными строками с несколькими проверками и mutations. Это не самостоятельный доказанный exploit, но повышает риск неверного review. При focused исправлении оформить затронутые policy/progress функции обычным читаемым TypeScript с именованными predicates и краткими invariants; не устраивать массовую косметическую переработку проекта.

## 6. План доведения до production

| Очередь | Обязательная работа | Критерий перехода |
|---|---|---|
| **R2.1.1 — сейчас** | Durable S03 predecessor context и корректный remaining plan без replay; negative drift/proof controls | Все 13 reviewer S03 outcomes соответствуют oracle; новые subprocess/TTL/crash cases; прежние 429 тестов и frozen checks сохранены |
| R2.2 | Полный C13 plan format и context binding: host, owner session, version lock, release, observations, explicit target | Согласованные producer/consumer/schema/docs, substitution/stale-context negatives, без фиктивных hashes и переноса старых approvals |
| R3 | Оставшиеся cancel/lock/expiry/concurrency и truthful cleanup/error semantics | Остановки/рестарты не дают replay, ложного cleanup-success и обхода admission |
| Q1B | Process supervisor, descendants, bounded I/O/timeouts, env/cwd/stdin, supported-host checks | Harmless owned-process tests и отрицательные host cases; ещё без production credentials |
| Q2 | Реальная узкая sudo-модель; root-owned safe writes; APT provenance; рабочий SSH/UFW cutover/rollback/timer; Docker safety | Реальные implementations вместо markers/stubs; затем отдельно квалифицированные disposable-host сценарии |
| Q3 | Доверенный packaged M0 и полный offline путь S00…S07 | Проверенные release/lock/bootstrap artifacts, clean install, повтор, частичное восстановление |
| Q4 | Auth/secrets, budgets/live admission, backup/restore | Изоляция credentials и расходов; restore с PAUSED/unknown accounting; отдельный минимальный live smoke после разрешения |
| Q5 | Service/unattended, update, local inference и дополнительные platform paths | Собственные prerequisites M1/M2/negative tests; optional paths остаются blocked до доказательства готовности |
| Q6 | Qualification Ubuntu 24.04 amd64 для конкретного release | Clean/repeat/reboot/interruption/ENOSPC/network/permission/rollback/restore matrix, воспроизводимые artifacts и рабочие инструкции |

Q5 не обязан блокировать минимальный supervised cloud-only профиль, если необязательные paths надёжно отключены. Нельзя переносить PASS одного профиля на service/unattended или другие платформы. AF backlog и production не получают автоматического закрытия от локальной приёмки R2.

Из прежних существенных blockers по-прежнему видны незавершённый реальный `NodeAccessAdapter.applyCutover` и marker-based rollback, а также user-controlled staging для привилегированной записи Docker daemon config. Они вне R2.1 и требуют Q2; исправление gates не превращает эти paths в production-safe.

## 7. Действия владельца

1. Передать Copilot этот аудит, `../copilot-q1a-r2-1-1-task.ru.md` и reviewer evidence ZIP; checksum приложить для проверки целостности.
2. Попросить выполнить только R2.1.1 и вернуть report, полный local patch, tested manifest, evidence ZIP и checksum.
3. Передать эти файлы на следующую проверку. **Коммиты, push, ветки/worktree/PR не нужны; всё остаётся локально.**

Покупать VPS, включать sudo/SSH/Docker mutations или передавать credentials сейчас не требуется. Disposable-host qualification будет отдельным шагом после готовности соответствующих implementations и тестового сценария.

## 8. Доказательства и ограничения

В reviewer ZIP: исходный входной пакет, воспроизводимые runners, independent validation/comparison logs, новая `access-continuation-probes.cjs`, machine rows для baseline/master и `check-access-continuation.py` с отдельными режимами проверки наблюдаемого дефекта и требуемого исправленного поведения.

Новая S03 матрица выполняется полностью: harness exit 0; desired-product checker на master возвращает **exit 1 с 10 failed cases**. Это функциональный red result, не ошибка сборки или отсутствие module. Первоначальная ошибка самого reviewer harness — ожидание cancel exit 6 вместо контрактного 130 — сохранена отдельно и не засчитана продуктовым дефектом. Финальные прогоны используют 130 и завершились без harness errors.

Факты: проверены exact bytes, local tests, настоящая orchestration/stage logic с fake external adapters и реальные owned subprocesses прежних suites. Дополнительные S03 probes используют новые engine/stage instances в одном процессе и persistent engine state; отдельный OS-process S03 restart нужно добавить в исправлении. Это ограничение не устраняет найденный дефект: новые instances уже теряют predecessor context при наличии доказанного checkpoint.

Предположение, уверенность **95%**: в будущей настоящей SSH/firewall реализации такие replay/stall будут повышать риск нарушения доступа и непредсказуемого поведения rollback timer. Реальный lockout этим review не воспроизводился и не заявляется.

**NOT RUN:** реальные sudo/APT/systemd/SSH/UFW/Docker-daemon/cgroups, OAuth/credentials/provider/model calls, VM/VPS provisioning, deploy/release, physical power loss. Это целевой review R2.1 и его взаимодействий с прежними исправлениями, а не новая полная квалификация всех AF-01…AF-31. Главный предел проверки — внешние effects моделируются; следующий шаг улучшает именно доказательство продолжения S03, затем потребуется реальная квалификация подготовленного release.
