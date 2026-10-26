# Agent Factory — проверка R1.6 и переход к R2

Дата: 2026-10-25, Europe/Amsterdam. Проверенный master: `5fde93d2c470171039698c35478c020085ef66ff`, tree `f8bca0179c0ce0f583c947a6d53e9852f38fba89`.

**Решение: принять R1.6 в заявленном локальном объёме. R15-F01 закрыт. Production и весь Q1A остаются OPEN.** Следующий пакет — **Q1A-R2.1: обязательная политика plan admission и срок действия плана**. Проверка следующего блока выявила два подтверждённых дефекта; оба воспроизводятся и на предыдущей базе, не внесены R1.6.

Формат доказательств: ниже отдельно указаны проверенные факты, выводы и ограничения. Уверенность в конкретных воспроизведённых исходах — **99%**; это не вероятность отсутствия иных ошибок.

## 1. Проверенные исходники и артефакты

Использованы именно вложения с суффиксами `(1)` / `(2)`, перечисленные в текущем сообщении, а не похожие предыдущие uploads. Отчёт прочитан целиком. Входной ZIP безопасно распакован в отдельную папку; проверены пути, типы записей, размер, CRC и внутренние checksums.

| Проверка | Подтверждённый результат |
|---|---|
| Base локального R1.6 patch | `420e5456d3e05b1c4f9b7202cacebb82baaf61eb`, tree `2dd3d1a1557e9687482b308eff16c0a0da399cd2` |
| Delta base относительно R1.5 `b888082` | Только четыре audit input-файла; setup/AGENTS/нормативная документация идентичны |
| Входной patch SHA-256 | `067c9c23c2b0120b271b26f59f4d9ffa0db7d1421a134566166cc52faab8ced6` |
| Входной ZIP SHA-256 | `13c9d74371d0e9fe9203e221ccd838af4d3d0f37ed4ac9ae8013088147bb5930` |
| ZIP integrity | 107 записей; CRC корректен; все 106 внутренних SHA256SUMS совпали |
| Tested-tree manifest | 138 файлов, SHA-256 `a95c623dde5996cf6abf4f93d9b03e76fdaef9fe0fc5ca6b6ced11fe0a9de5cb` |
| Master ↔ manifest | Все 138 файлов совпали |
| Base archive + приложенный patch ↔ manifest | Все 138 файлов совпали; восстановление без git index |
| Вложения ↔ bundle | Приложенные report/patch совпадают с bytes внутри ZIP; опубликованный пакет проверен отдельно |

Отчёт корректно описывает локальную работу агента до публикации. Его фраза «на GitHub этих локальных правок нет» к текущему состоянию master уже не относится. Публикация пользователем не противоречит запрету на публикацию агентом; по одному коммиту невозможно установить, кто выполнял команды.

Изменён **один production-файл** — `../../setup/src/adapters/git.ts`. Прочитаны весь его diff, новые 189 строк integration tests, оба helpers, обновлённая application-release документация, evidence runners/checkers и итоговые логи. ProcessAdapter, stages, core/state, schemas/locks и M0 не менялись. Аудитор не вносил исправления в продуктовый репозиторий.

## 2. Независимые результаты R1.6

Среда: Linux x86_64, Node **v24.22.1**, npm **11.9.0**. Автор пакета использовал macOS arm64, Node v24.12.0, UID 501. Аудиторская среда имеет UID 0; запускались тесты и локальные fixtures, а не CLI развёртывания от root. Это не проверка owner session на целевом VPS.

| Проверка | Результат аудитора |
|---|---|
| `npm --prefix setup ci --ignore-scripts --no-audit --no-fund` | Exit 0 |
| `npm --prefix setup run typecheck --silent` | Exit 0 |
| `npm --prefix setup run test --silent` | **397 pass / 0 fail / 0 skip** |
| 138 tested-file hashes до/после прогона | Не изменились |
| Исходный неизменённый W01…W04 harness, adapter и stage modes, baseline/fixed | Все ожидаемые исправления подтверждены |
| `check-r16.py` на самостоятельно полученных логах | **37 assertions PASS**; один из них агрегирует прежние 33, поэтому не суммировать это как 70 уникальных сценариев |
| Frozen R1.5 comparisons/C01…C12 | **33 assertions PASS** |
| S00…S07 composition + lifecycle/stage/no-op controls | Прежние ожидаемые исходы сохранены; external effects моделируются |

Из собственного полного suite выделены: 14 `R16_REAL_COMMAND` rows, 24 `R16_REFUSAL`, 4 `R16_PROBE_CONTROL`, 36 R14 manifest fault rows, 10 R14 child crash rows, 4 recovery-write faults, 10 R15 Docker faults и 3 Docker child crash rows. Это реальные исполнения локальных test workers и моделирование внешних adapters; не квалификация APT/Docker/SSH на host.

### Что подтверждено по исправлению

| Сценарий | R1.5 baseline | R1.6 |
|---|---|---|
| W01: обычный `.js` | Проверенный entry исполняется | Положительный путь сохранён |
| W02: `.cjs` + другой CWD + одноимённый decoy | Исполняется CWD decoy | Исполняется checked absolute entry |
| W03: extensionless + другой CWD | Исполняется CWD decoy | Исполняется checked absolute entry |
| W04: hashed `--eval` + expression + `--` | Исполняется inline expression | `s05_command_content_unbound`, executable calls=0, нет `verified` |

В обоих режимах fixed 4/4 безопасных исхода. Baseline 1/4. Stage-mode harness явно использует synthetic archive/checkout/receipt; код schema/hash/command/process настоящий. Дополнительный W09 в suite использует **engine-generated materialization receipts**, а не вручную нарисованный trust proof. Поэтому stage harness не является единственным свидетельством integration correctness.

Общая `prepareOfflineCommands` действительно используется admission и invocation. Оба required commands готовятся до первого child, file entry становится абсолютным независимо от suffix, runtime flags перед Node entry запрещены даже при совпадении с hashed filename. App args после entry сохраняются без shell splitting; direct executable не получает Node-specific переписывания. Перед каждой help-командой остаётся проверка актуального content/metadata. Невалидный второй command не позволяет сначала исполнить первый.

Недостаток R15-F01 можно закрыть без новой R1.7 итерации. Неподдержанные loaders/runtime flags, вся dependency closure приложения, M0/service compatibility и OS-level hash/exec races этим не сертифицируются. Report правильно оставляет эти границы открытыми и исправляет прежний слишком широкий V03 claim без переписывания истории.

## 3. Следующий блок: R2-F01 — план сам определяет, нужны ли ему approvals

**P1 / высокая серьёзность, OPEN. Подтверждённый факт; уверенность 99%.** Связь с прежним backlog: AF-02/03 и Q1A-R2 plan/gate admission. Это не регресс R1.6.

В `../../setup/src/core/engine.ts`, `validateApplyPlanAdmission` (строки 757–771), сравниваются два списка из одного входного плана: `operations[].gate_ids` должны присутствовать в `stage.required_gates`. Нормативный набор gates для конкретных операций из trusted stage policy не восстанавливается. Если удалить **оба** списка, проверять нечего.

`runApply` (строки 1052–1115) проверяет self-hash и затем перебирает gates, перечисленные в этом же плане. `ensureNonInteractiveGates` рассматривает pending gates только с новым plan hash. Согласованность двух подконтрольных входных массивов не является независимой проверкой разрешения.

Независимый `evidence/r2-admission-probes.cjs` использует настоящий `SetupEngine` и **настоящий `createSystemStage` S02**. Только APT adapter заменён безопасными counters. Сначала engine сам генерирует plan с `s02-sudo-apt-update` и `s02-sudo-apt-install`. В отрицательном сценарии approvals не выдаются; из JSON убираются stage/operation gates и пересчитывается canonical SHA-256. Такой plan schema-valid. Затем выполняется обычный `apply --non-interactive` через engine.

| Case | Approvals | Результат | APT counters refresh / simulate / install |
|---|---:|---|---|
| R2A01: неизменённый, approved plan | 2 | Exit 0, S02 verified | 1 / 1 / 1 |
| R2A02: неизменённый, без approvals | 0 | Exit 4 `manual_gate_required` | 0 / 0 / 0 |
| **R2A03: удалены оба списка + новый self-hash** | **0** | **Exit 0, S02 verified** | **1 / 1 / 1** |
| R2A04: удалён только stage list | 0 | Exit 2 `plan_gate_representation_mismatch` | 0 / 0 / 0 |
| R2A05: оба списка удалены без исправления hash | 0 | Exit 2 `plan_hash_invalid` | 0 / 0 / 0 |

Результаты показывают, что schema/hash и текущий mismatch guard работают, но их недостаточно. Hash плана — контроль целостности содержимого, не подпись policy и не разрешение на эффект. Нельзя исправлять это только запретом пустого списка: существуют законные операции без gates, и необходимы проверки подмены непустым, но неверным списком.

**Граница доказательства:** реальные sudo/apt команды не выполнялись. Подтверждён вызов путей producer, соответствующих APT effects, без обязательных approvals. Системный sudo всё ещё независимо решает, разрешена ли root-команда; обход Unix sudo authentication/повышение привилегий этим тестом не доказаны. Риск возникает там, где owner уже располагает требуемыми sudo-полномочиями: application-level review barrier не срабатывает.

Требуемое исправление: проверять разрешённую семантику операций и обязательные approvals по trusted stage/operation policy, независимо от submitted plan. Сверять stage/id/kind/resource/risk/gates/preconditions и недопустимые omissions/reordering/duplicates. Перед effect выполнять fresh admission под lock. Сохранять legitimate explicit-stage closure, verified no-op и durable partial progress; нельзя заменить ошибку blanket отказом всех plans.

## 4. R2-F02 — нет самостоятельного срока действия плана

**P2 / средняя серьёзность отдельно от F01, OPEN. Подтверждённый факт; уверенность 99%.** В сочетании с неполным fresh admission риск выше. Не утверждается, что существующий 30-минутный TTL gates отсутствует: gate TTL реализован и его тесты проходят.

`../../setup/src/core/plan.ts`, `createPlanFile` / `validatePlanConsistency` (строки 135–145, 170–215), записывает `created_at`, но при apply проверяет только installation/contract/config hash/self-hash. Возраст и допустимость времени не проверяются; валидатор не получает clock. `setup/schemas/plan.schema.json` допускает очень слабый timestamp pattern и не содержит expiry.

CONTRACT C13 явно требует 30-минутный срок плана; C06 требует повторной проверки входов перед effects. Независимые сценарии здесь используют настоящий engine, injected clock и **явно synthetic low-risk stage без gates**, чтобы не спутать срок плана со сроком approvals:

| Case | Возраст исходного, не редактированного плана | Результат | Effects |
|---|---:|---|---:|
| R2A06: positive control | 5 минут | Exit 0 | 1 |
| **R2A07: expired plan** | **31 минута** | **Exit 0** | **1** |
| **R2A08: clock rollback / future timestamp** | **−60 минут** | **Exit 0** | **1** |

Для R2A08 clock перемещён назад после генерации, файл не правился. Это не утверждение, что злоумышленник может менять системные часы: проверяется поведение при недопустимой временной связи. На границе `now >= expiration` должен быть отказ; новый explicit plan — отдельное действие, а не тихое продление старого.

Требуемое исправление ближайшего пакета: один injected clock, строгий timestamp, 30 минут, проверка после lock и перед следующим effect. Если срок истёк после уже завершённой операции, сохранить известный progress и не запускать следующую. Проверка не должна преждевременно убивать APT посреди операции; процессный cleanup — отдельная задача.

### Более широкий R2 backlog — подтверждённая неполнота, не дополнительные доказанные exploits

В сериализованном плане сейчас нет требуемых C13 `host_fingerprint`, `version_lock_hash`, `observations_hash`, `generated_at`/`expires_at`; используется иной `created_at + stages` формат. Также config/plan читаются до получения lock, а последующий admission использует загруженные объекты. Эти факты видны в коде. Наличие stage-specific content/hash checks и state host validation учитывать обязательно: **из отсутствия общего поля не следует, что каждый конкретный stage уже допускает соответствующий bypass**.

Полное приведение plan format к C13, binding host/owner session/lock/release/resource bytes и конкретные concurrent-substitution scenarios — следующий подэтап **R2.2**, после принятия R2.1. Не предлагается переписывать C13 под существующие недостатки. Приёмка R2.1 не закрывает весь R2.

## 5. Почему следующая задача именно R2.1

Все восемь новых R2 probe outcomes повторены на `b888082` и `5fde93d`; exit/effects/acceptance совпадают. Проблемы core существовали до R1.6. Его изменённый `git.ts` в этих сценариях не используется. Поэтому результат R1.6 — PASS local, а новые задачи переходят в ранее запланированный R2.

R2.1 закрывает два конкретных admission gaps, не смешивая их с полной заменой public plan schema, системным sudo executor и новым state recovery protocol. Это уменьшает риск повторного повреждения уже проверенных receipts/journal/partial-progress границ. В следующем промпте явно перечислены positive controls и сохранение 397 tests, а не только отрицательные сценарии.

| Очередь | Что сделать | Условие завершения |
|---|---|---|
| **R2.1 сейчас** | Trusted operation/gate policy + plan TTL/future-time refusal + проверка актуальности под lock | R2-F01/F02 закрыты; valid/no-op/partial/relogin paths сохранены |
| R2.2 | Полный plan contract и context binding: host/session/config/lock/release/observations; replay/substitution/concurrency | Меняющиеся bytes/identity не получают старое authorization; format/migration соответствует C13 |
| R3 | Остаточная cancel/expiry/lock coverage, truthful errors/cleanup и concurrency | Нет незаметного replay/ложного cleanup-success; не повторять уже доказанные per-operation fixes без причины |
| Q1B | Process-tree supervisor, bounded output/timeout, env/cwd/stdin, supported-host admission | Контролируемые children/descendants/flood/termination и host negatives |
| Q2 | Узкая sudo-модель, root-owned safe writes, APT provenance, настоящий SSH/UFW rollback/timer, Docker enforcement | Готовые implementations и negative tests, затем отдельная disposable-host квалификация |
| Q3 | Packaged setup + reviewed M0, installer/application contract | Минимальный supervised/cloud-only/read-only toy путь без credentials, вне checkout |
| Q4 | Secrets/auth/live budget и uncertain outcomes, backup/restore | Изоляция секретов и подтверждённое восстановление; live отдельно разрешается владельцем |
| Q5 optional | Service/unattended/update/inference/platform runners | Отдельная capability qualification; не обязательное условие первого supervised MVP |
| Q6 | Exact-release qualification на disposable Ubuntu 24.04 amd64 | Fresh/repeat/reboot/relogin, отказ gates, cancel, disk/network faults, rollback/restore |

Известные sudo/host blockers остаются: пустой actual S03 cutover и marker-only rollback/timer; предсказуемый temporary JSON в Docker daemon config write; отсутствие общей квалифицированной privileged-execution границы. R1.6 этого не менял. Host mutation env switches не являются доказательством безопасности.

## 6. Действия владельца

1. Передать Copilot `../copilot-q1a-r2-1-task.ru.md`, этот аудит и приложенный evidence ZIP. Выполнять только R2.1.
2. **Все изменения оставить локально: без commits, push, новых веток, worktree/PR, release/deploy.** Запрет уже включён в ТЗ и распространяется на следующие генерируемые промпты.
3. Получить отчёт, полный patch с новыми файлами, tested-tree manifest и evidence ZIP/checksum. Для следующего review передать именно эти файлы. Публиковать изменения для review не требуется.
4. Сейчас не нужны VPS, credentials, GitHub Actions или ручные изменения sudoers. Интеграция и реальное развёртывание остаются более поздним этапом.

## 7. Выводы, допущения и самопроверка

**Подтверждено:** совпадение исходников/patch/manifest, 397/397 suite, реальные argv/CWD controls, 33 + 37 assertions с оговоркой об overlap, закрытие прежнего R15-F01, R2A03/R2A07/R2A08 failures. Уверенность 99%.

**Вывод:** R1.6 local scope можно принять и перейти к R2.1. Уверенность 98%; остаётся обычная неопределённость неполного охвата всех возможных inputs. **Предположение о последствиях:** при разрешённом системном sudo обход application gates может допустить нежелательные host mutations. Реальный exploit/root escalation не выполнялся и его практическая достижимость на конкретном VPS неизвестна.

**NOT RUN:** disposable VM/VPS, реальные sudo/apt/systemd/SSH/UFW/Docker daemon/cgroups, OAuth/credentials/provider/model/GitHub writes, release/deploy и physical power loss. Из новых процессов запускались только принадлежащие тестам stdout/argv fixtures; потенциально опасные Node option negatives перехватывались до child.

Самопроверка: принимаю выполненный scope, не переношу старый core blocker на оценку diff R1.6; gate TTL не путаю с plan TTL; fake APT counters не называю настоящим sudo execution; self-hash не считаю цифровой подписью; отсутствие общих binding fields не выдаю за доказанный обход каждого stage. Полная новая ревизия всех неизменённых модулей в этом проходе не проводилась; production не квалифицирован.
