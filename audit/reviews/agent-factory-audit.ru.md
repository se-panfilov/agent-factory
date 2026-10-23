# Аудит agent-factory: код, развёртывание и безопасность

Дата: 22 октября 2026. Репозиторий: https://github.com/se-panfilov/agent-factory

Проверенный commit: `7d845248e7fcd089a36afc8b395b38c7226e09e7` (HEAD при получении репозитория). Выводы относятся именно к нему.

**Редакция 2 — сверка независимого аудита, 22 октября 2026.** Проверены все 39 пунктов `AUDIT-agent-factory-7d84524 (1).md` и исходники приложенного `poc.tgz`. Новые обоснованные детали включены в соответствующие AF-группы; отдельная находка S04 добавлена как AF-31. В конце — полная таблица EXT-ID → решение → наш AF-ID, дополнительные воспроизведения и поправки к спорным утверждениям. Нумерации двух аудитов различаются: `EXT-AF-111` не означает наш `AF-11`.

## Вердикт

**NO-GO для реального VPS, credentials и production deployment.** Причина не только в отложенных VM-тестах: обнаружены воспроизводимые ошибки, из-за которых документированный путь установки не работает, проверки могут давать ложный успех, восстановление способно записать непроверенные файлы за пределами целевого каталога, а граница повышения привилегий недостаточно защищена.

**Подтверждённые факты — уверенность 99%:** штатные 81 тест setup и 23 теста приложения проходят; проходят оба typecheck и отдельный fake self-test M0 runner. При этом независимые локальные проверки подтвердили сброс gates, отсутствие конфигурации в свежем S05, ложный verified на неподдерживаемом host, потерю текущего state при ENOSPC, restore через symlink, потерю cwd и неполный release payload.

**Инженерный вывод — уверенность 98%:** существующие зелёные тесты доказывают главным образом согласованность отдельных модулей с их fake-окружением. Они не доказывают совместимость installer ↔ packaged application ↔ реальная ОС.

Это не утверждение о состоявшемся взломе или доказанной удалённой root-RCE. Для атак на privileged writes обычно требуется локальная возможность менять конкретные входы/каталоги и разрешённый sudo-вызов владельца. Ни эксплуатации настоящего сервера, ни проверки реального sudo в рамках аудита не проводилось.

## Объём и метод

Проверены CLI, core engine/state/plan/gates/lock, bootstrap и release scripts, системные адаптеры, этапы S00–S14, backup/restore/emergency/update, M0 runner и его пакет, schemas, templates, CI, тестовые стратегии и актуальные документы репозитория. Сопоставлялись `../../AGENTS.md`, обе копии CONTRACT 1.0.0, `USER MANUAL.md`, документация setup, implementation reports и relevant automation/application contracts.

Изменения приложения не вносились. Зависимости установлены локально по lockfiles с `--ignore-scripts`; тесты запускались в изолированной рабочей копии. Специальные воспроизведения использовали временные каталоги и fake process adapters. Не запускались sudo, apt mutations, Docker daemon, SSH/firewall changes, OAuth, model calls, GitHub writes или VM provisioning.

Обозначения:

- **P0** — до исправления нельзя доверять опасной операции либо её подтверждению безопасности.
- **P1** — блокирует заявленное развёртывание/работу или создаёт существенный риск потери данных.
- **P2** — важное исправление корректности, сопровождения или доказательности.
- **R** — воспроизведено локальной проверкой; **S** — подтверждено статическим анализом исполняемого пути; эксплуатационные последствия без VM остаются оценкой.

Ниже 31 группа замечаний. Исходные AF-01…AF-30 сохранены; AF-31 добавлена после сверки второго аудита. Группа может содержать несколько тесно связанных дефектов. Это не CVE-оценки и не подсчёт всех возможных уязвимостей.

## Реальный минимальный путь и места разрыва

| Участок | Что обнаружено | Результат сейчас |
|---|---|---|
| Build setup release | npm script вычисляет `setup/setup`; пакет не содержит runtime dependencies | Документированная сборка/запуск не работают |
| Bootstrap | Относительный release-dir сохраняется в launcher, receipt не перепроверяется S00 | Работа зависит от cwd; receipt не является доказательством |
| Init → plan | По умолчанию выбран только S01 | Quickstart не приводит к runner |
| Plan → approve → apply | Gates создаются только в apply и каждый раз сбрасываются | Опасные этапы нельзя штатно пройти |
| S03 | cutover/rollback представлены маркерами | Нет обещанной реализации защиты доступа |
| S04 | Официальный apt repo должен уже существовать; используются candidate versions | Чистый VPS не подготовлен полностью |
| S05–S07 | lastConfig хранится только в памяти; M0 manifest/policy несовместимы | Нет сквозного offline MVP |
| S08 | OAuth без сети и без настоящего TTY; несовместимый smoke protocol | Нет работающего live admission |
| S10 / unattended | M1/M2 отсутствуют; есть дополнительные дефекты service adapter | Правильно оставлять blocked до разработки приложения и исправления installer |
| S11 / S14 | Restore gates/целостность/атомарность и update recovery нарушены | Не использовать как защиту от потери данных |
| S12 / S13 | Inference health синтезируется; checker/browser adapter не готов | Нельзя заявлять готовую hybrid/cross-platform factory |

## Замечания

### AF-01 — P1 — Контекст этапов не переживает отдельный CLI-процесс [R/S, 100%]

Исходники на проверенном commit: [setup/src/stages/application.ts:318](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/application.ts#L318); [setup/src/core/engine.ts:379](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/core/engine.ts#L379).

**Код:** `setup/src/stages/application.ts:createApplicationStage`, аналогично configuration/verification/auth/project/service/operations/inference/platforms/update; `setup/src/core/plan.ts:createPlanFile`; `setup/src/core/engine.ts:runApply`.

`lastConfig` заполняется только в `plan()`. При отдельном `factory-setup apply` создаются новые модули, `plan()` не вызывается, `observe()` видит пустой контекст, а `apply()` возвращает `s05_config_not_initialized` и аналогичные ошибки. Даже при планировании `observe()` вызывается ДО установки lastConfig, поэтому часть планов содержит `pending` вместо реальных hashes. `verify --stage S07` в новом процессе страдает от той же проблемы. `resume` внутри одного engine частично маскирует дефект, но не исправляет контракт.

**Исправление:** передавать validated immutable config и зависимости явно в StageContext/конструктор всех stages до observe; убрать lifecycle-зависимость от plan и общего mutable lastConfig. Исполнить lifecycle в разных процессах с сериализацией plan на диск. Plan должен содержать действительные preconditions либо явный blocker, а не wildcard `pending`.

**Приёмка:** init/plan/approve/apply/status/verify/resume независимыми процессами; запуск из разных cwd; S05–S14 никогда не требуют предварительного plan в том же процессе.

### AF-02 — P1 — Одобрения gates сбрасываются перед исполнением [R, 100%]

Исходники на проверенном commit: [setup/src/core/gates.ts:41](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/core/gates.ts#L41); [setup/src/core/engine.ts:435](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/core/engine.ts#L435).

**Код:** `core/gates.ts:upsertPlanGates`; `core/engine.ts:runPlan,runApply`.

`plan` не сохраняет gates. `apply` вызывает upsert, который перезаписывает даже approved запись значением pending, затем `ensureGateApproved` отказывает. После approve следующий apply повторяет сброс. Независимая проверка: `approved → pending` при неизменном hash. В noninteractive apply предварительная проверка также не создаёт отсутствующие gates.

Дополнительные исходники: [setup/src/core/gates.ts:8](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/core/gates.ts#L8).

**Дополнение после независимой сверки:** Clock применяется непоследовательно: `approveGate/upsertPlanGates` получают injected clock, а `ensureGateApproved/requiredGatesForPlan` используют `Date.now()`. TTL-тесты на fake clock не моделируют весь production path. Использовать один clock для создания, списка, approve и execution; проверить границу 30 минут, отсутствие продления и отказ approve уже истёкшего gate.

**Исправление:** сохранять pending gates вместе с конкретным планом; сохранять действующее approval при полном совпадении binding; истечение/изменение входов инвалидирует approval, но не продлевает его. Привязать gate к host, owner/session, operation, resources, hashes и expiry. Все paths исполнения должны пользоваться одним verifier.

**Приёмка:** fresh plan → gate list → approve → apply проходит; отказ, expiry, чужой plan/host/session/resource отклоняются; повторный apply не сбрасывает и не обновляет TTL.

### AF-03 — P0 — Plan не связывает разрешение с фактическими входами [S, 99%]

Исходники на проверенном commit: [setup/src/core/plan.ts:167](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/core/plan.ts#L167); [setup/src/stages/configuration.ts:1290](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/configuration.ts#L1290).

**Код:** `core/plan.ts:validatePlanConsistency`; `core/types.ts:InstallerPlan`; `stages/configuration.ts:plan,apply`; `stages/inference.ts:apply`.

Сравниваются config hash и self-hash plan. Нет обязательных plan expiry, host fingerprint, version-lock content hash и полноценного observed-state binding. Значение `version_lock_path` хешируется как строка, содержимое может измениться. S06 допускает `pending` preconditions без проверки соответствующего hash; S12 цикл проверки preconditions просто выполняет `continue`. Engine не реконструирует разрешённый DAG/operations из registry и не запрещает S08/S14 через общий apply согласно явным verbs.

**Риск:** одобренное действие может исполняться уже с другими pins, файлами или условиями. Self-hash не является подписью и не заменяет проверку допустимого плана.

**Исправление:** канонический план C13 с полным closure, version/host/input/observation hashes, expiry; reobserve непосредственно перед каждой mutation; typed operations без произвольных commands из plan; policy admission независимо от редактируемых полей плана. Неполные preconditions → blocked.

**Приёмка:** изменение содержимого lock/release/template/policy при том же пути; просроченный, переупорядоченный, чужой и лишённый gates план; общий apply с запрещённым stage — отказ до side effect.

### AF-04 — P0 — Ложный verified и слабый preflight [R/S, 100%]

Исходники на проверенном commit: [setup/src/stages/preflight.ts:27](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/preflight.ts#L27); [setup/src/core/engine.ts:618](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/core/engine.ts#L618).

**Код:** `core/engine.ts:bootstrapStage,runApply,runVerify,runStatus`; `stages/preflight.ts:probeDisk,observe,verify`.

S00 считает достаточным существование receipt. S01 status зависит лишь от строки версии ОС: root, systemd, RAM/CPU/disk и expected user не блокируют выполнение. Free disk вычисляется из `stat(directory).blocks * blksize`, что не измеряет свободное место файловой системы. Архитектуры, кроме arm64, преобразуются в amd64. verify возвращает receipts с отрицательными checks без ошибки, а engine помечает этап verified по факту наличия receipt. Apply игнорирует результаты post-verify и записывает pre-apply observation как verified. Повторный S01 observe возвращает planned, что конфликтует с записанным verified. Status refresh обновляет только S01; default verify тоже не проверяет всю выбранную установку.

**Воспроизведение:** fake host с неподдерживаемой ОС, root, отсутствующим systemd и нулевыми ресурсами; `verify` вернул exit 0 и verified для S00/S01.

**Исправление:** явный результат проверки с обязательными predicates; central aggregate не повышает blocked/skipped/failed; реальные statfs/free inode probes; OS ID+VERSION_ID, arch, Node pin, user/UID и filesystem checks; сверка bootstrap receipt с реальными artifacts. Refresh/verify должны покрывать выбранный closure и инвалидировать dependents.

**Приёмка:** missing receipt, modified node, root, wrong user/OS/arch/version, no systemd, low memory/disk/inodes, invalid lock semantics дают соответствующий ненулевой exit; второй запуск без drift успешен.

### AF-05 — P0 — Crash/ENOSPC может обнулить историю установки [R/S, 100%]

Исходники на проверенном commit: [setup/src/core/state.ts:103](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/core/state.ts#L103); [setup/src/core/state.ts:182](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/core/state.ts#L182).

**Код:** `core/state.ts:saveState,loadState`; `core/engine.ts:runApply`.

До записи нового state текущий `state.json` переименовывается в `.previous`. При ENOSPC/kill между rename и успешной записью primary отсутствует. `loadState` не восстанавливает `.previous`, а создаёт новый пустой state. Corrupt JSON также перемещается в quarantine без durable recovery blocker; следующий запуск видит отсутствие primary. При ошибке apply in-flight operation безусловно очищается, даже если side effect произошёл частично. Intent для всех операций записывается заранее; receipts не сохраняются полноценно в stages.

**Воспроизведение:** fault injection writeText=ENOSPC после существующего state; primary исчез, previous остался, новый load вернул `last_error: null`.

**Исправление:** сначала durable new generation, безопасная previous-generation стратегия, atomic replace без окна «нет current», fsync parent; missing current + previous/quarantine → recovery, никогда fresh init. Сохранять interrupted/unknown operation до reconciliation. Intent/receipt/checkpoint — на каждую операцию непосредственно перед/после неё.

**Приёмка:** crash на каждой границе write/fsync/rename/mutation, ENOSPC и torn JSON; нельзя потерять in-flight или принять повреждение за новую установку.

### AF-06 — P0 — Lock, cancel и recover не обеспечивают заявленную остановку [R/S, 99%]

Исходники на проверенном commit: [setup/src/core/lock.ts:130](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/core/lock.ts#L130); [setup/src/core/engine.ts:509](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/core/engine.ts#L509).

**Код:** `core/lock.ts`; `core/engine.ts:runApply,runRecover,runBackupCreate,runRestore,runSmoke`.

State загружается до lock; plan/gate/status/verify/auth/smoke/backup/restore могут писать state вне общего lock. Recover lock-only не проверяет дочерние/контейнерные операции, может quarantine каталог без owner в окне его создания. Release удаляет lock без сверки nonce. `/proc/stat` разбирается split по пробелам без учёта process comm. Cancel читается только ПОСЛЕ всех stages. Полный recover возвращает success с текстом «не реализовано». У installer нет согласованных SIGINT/SIGTERM cleanup handlers.

Дополнительные исходники: [setup/src/core/lock.ts:109](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/core/lock.ts#L109).

**Дополнение после независимой сверки:** Дополнительно воспроизведено: `requestCancel` создаёт файл только с installation ID/временем; `consumeCancelRequest` не читает содержимое и принимает любой существующий файл. Отложенный cancel относится уже к следующему apply. Подмена nonce в `lock/owner.json` после acquire не мешает старому `release()` удалить новый lock. Cancel должен содержать identity адресуемого запуска/lock nonce, иметь atomic write и не затрагивать следующий run; чужой nonce запрещает release. Эти два сценария добавить в regression tests.

**Исправление:** единая сериализация всех mutation и state writes; load под lock; identity-aware lock release/recovery, проверка orphan resources; отдельный atomic cancellation channel с наблюдением во время операций и между ними; полноценный dispatcher recover. Unknown cleanup → exit 8. Apt требует отдельного safe-boundary протокола, а не обычного kill timeout.

**Приёмка:** два CLI одновременно, PID reuse, owner.json absent/partial, boot change с orphan container, cancel во время download/apt/build; restore/update/backup не пересекаются; no-op recover не выдаёт success.

### AF-07 — P0 — Не сформирована безопасная модель sudo [S, 99%]

Исходники на проверенном commit: [setup/src/adapters/apt.ts:192](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/adapters/apt.ts#L192); [setup/bootstrap.sh:15](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/bootstrap.sh#L15).

**Код:** `adapters/apt.ts:ensureSudoAvailable,runSudoApt`; `adapters/systemd.ts:runSudo`; `adapters/docker.ts:runSudo`; `bootstrap.sh`; `stages/preflight.ts`.

CLI целиком не отказывает root. Apt проверяет `sudo -n /usr/bin/true`, что не доказывает полномочия на apt и отвергает пользователя с корректным ограниченным разрешением только нужных команд. Сообщение предлагает «passwordless/scoped sudo», хотя контракт запрещает NOPASSWD. Systemd использует иной режим sudo без `-n`, при этом stdin process adapter закрыт. Env switches включают host mutations; bootstrap имеет AUTO_APPROVE_SUDO и ALLOW_MOCK_BINARIES в production entrypoint.

**Что НЕ подтверждено:** код не создаёт sudoers NOPASSWD автоматически. Опасна рекомендация и отсутствующая целостная модель, а не обнаруженная установка sudoers.

Дополнительные исходники: [setup/src/stages/docker.ts:173](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/docker.ts#L173); [docs/automation/agent-factory-guide.ru.md:1871](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/docs/automation/agent-factory-guide.ru.md#L1871).

**Дополнение после независимой сверки:** Уточнить модель угроз: `gate approve` меняет owner-writable state; произвольный враждебный процесс того же UID способен вызвать CLI или изменить файл. TTY, typed confirmation, nonce, session binding и `sudo -v` улучшают процедуру одобрения, но НЕ создают границы против такого процесса. Не обещать «human-presence proof» через `sudo -k && sudo -v`. Непроверенный Worker/ИИ-код не должен исполняться как доверенный host control plane, иметь его файловый доступ, sudo-контекст или Docker socket. Для service с доступом к rootful Docker доверие к control plane равно доверию администратору VPS; systemd hardening этого не отменяет. При необходимости защиты от того же UID требуется отдельная реально защищённая authority/изоляция, а не ещё один JSON-флаг.

Риск группы Docker уже обозначен: `s04-docker-group-root-equivalent-ack`, side effect «root-equivalent» и guide прямо это говорят. Поэтому тезис второго аудита о *молчаливой* выдаче прав отвергнут. Исправить работоспособность/binding этого gate и описать роли owner/control plane/worker; rootless Docker — возможная отдельно квалифицируемая архитектура, а не обязательная замена без проверки контрактов.

**Исправление:** ordinary-owner guard на все реальные CLI paths; единый reviewed механизм кратковременных privileged операций. Отдельное явное подтверждение exact diff/argv и интерактивная аутентификация владельца в контролируемой terminal session; проверять необходимые разрешения, не `/usr/bin/true`. Не предлагать и не создавать wildcard sudoers, NOPASSWD, `sudo node`, произвольный shell/root broker. Test hooks вынести в fixtures/test build. Не считать `sudo -v` из другого tty гарантией доступности timestamp дочернему процессу.

**Приёмка:** ordinary sudo с паролем, expired credentials, denied command, non-TTY, root запуск, scoped sudo, env bypass — отдельные tests; без approvals нет privileged spawn.

### AF-08 — P0 — Privileged writes используют недоверенные пути/файлы [S, 98%]

Исходники на проверенном commit: [setup/src/adapters/docker.ts:674](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/adapters/docker.ts#L674); [setup/src/adapters/systemd.ts:147](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/adapters/systemd.ts#L147).

**Код:** `adapters/docker.ts:mergeOwnedDaemonLogConfig`; `adapters/systemd.ts:installUnit,ensureDirectory,syncRelease,backupFile,restoreFile`; `adapters/filesystem.ts`.

Docker пишет предсказуемый `/tmp/agent-factory-s04-daemon-<Date.now>.json` через обычный writeFile, затем sudo install. Проверяется final daemon path, но не вся цепочка parent/ownership/гонок. Systemd копирует unit из owner-writable каталога в /etc и release через `sudo cp -a`, сохраняя владельца пользовательских файлов. Нет общего privileged path/argument allowlist. Проверка абсолютного пути не доказывает доверенность binary или source. Изменённый unit потенциально меняет User/ExecStart и превращает подтверждённую установку сервиса в выполнение другого кода.

Дополнительные исходники: [setup/src/stages/service.ts:679](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/service.ts#L679); [setup/src/adapters/systemd.ts:195](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/adapters/systemd.ts#L195).

**Дополнение после независимой сверки:** `syncRelease(application_dir, /opt/.../<commit>)` копирует всё дерево `cp -a`, а при существующей цели молча ничего не делает. При разрешённом layout `app/auth`, `app/state`, `app/work` в release попадают секреты и изменяемые данные; возможна копия `.git`. Это дополнительная копия credentials вне их lifecycle, не доказательство world-readable утечки. Запись команд реального адаптера с fake process подтвердила полный source и отсутствие каких-либо команд для уже существующей цели; настоящий sudo/cp не выполнялся.

Копировать только полный проверенный inventory release payload; исключить auth/state/work/checkout metadata, сохранить необходимые reviewed runtime dependencies. Существующий release сверять по content hash и ownership; несовпадение — drift. Нельзя лечить это только `chown -R` на произвольном пути. Проверять candidate `daemon.json` ДО замены рабочего файла и сохранять предыдущее root-owned поколение для rollback.

**Исправление:** root-owned staging с безопасным открытием, проверенными parent/ownership и отказом для symlinks/hardlinks/special files; trusted fixed targets/commands; validation и применение одних и тех же bytes; atomic root-side replacement и backup. Root release code должен быть действительно immutable для service/worker UID. Никаких рекурсивных chown/cp на произвольных config paths.

**Приёмка:** подмена source между проверкой/копированием, symlink parent/leaf, precreated temp, hardlink, writable release binary, чужой unit; отказ ДО root write. Нужна VM-проверка, не только mock argv.

### AF-09 — P0 — S03 имитирует SSH/firewall cutover и rollback [S, 100%]

Исходники на проверенном commit: [setup/src/stages/access.ts:900](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/access.ts#L900); [setup/templates/systemd/access-rollback.sh:21](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/templates/systemd/access-rollback.sh#L21).

**Код:** `stages/access.ts:NodeAccessAdapter.stageManagedCutover,armRollbackTimer,applyCutover,rollbackManagedCutover`; `templates/systemd/access-rollback.sh`.

Staging и timer пишут маркеры. `applyCutover` только проверяет env flag. Rollback меняет marker, не восстанавливает SSH/UFW. Private SSH reachability определяется `Tailscale Self.Online`, что не подтверждает независимый SSH login. Syntax check проверяет текущий sshd, а не применяемый candidate. Rollback template подавляет ошибки reload через `|| true` и не описывает полный комплект изменяемых drop-ins/UFW state.

Дополнительные исходники: [setup/templates/ssh/90-agent-factory-access.conf:5](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/templates/ssh/90-agent-factory-access.conf#L5).

**Дополнение после независимой сверки:** Rollback template восстанавливает только `sshd_config` и `ufw before*.rules`, не удаляет свой SSH drop-in и не восстанавливает `user.rules/user6.rules` и остальное реально изменённое состояние UFW. Root-owned rollback directory и backups не создаются рабочим adapter. Drop-in `90-*` не гарантирует приоритет над ранними cloud-init/includes: нужны effective `sshd -T` проверки с нужным контекстом, а не вера в имя файла. Restore должен возвращать точный прежний firewall state, не безусловно выключать firewall и открывать чужие сервисы.

Ручное evidence должно иметь host/plan/resource/time/nonce binding и честно описывать источник. Marker от того же UID либо самоутверждение JSON не доказывает внешний port scan. SSH-проверка с самого VPS также не доказывает независимый повторный вход; сохранить отдельный owner session/внешний probe.

**Исправление:** до полноценной реализации production adapter обязан возвращать blocked, не успешные receipts. Реализовать root-owned backups, staged candidate validation, systemd rollback timer с подтверждённым active state, частный независимый login/owner ack, staged cutover, проверку effective SSH и IPv4/IPv6 firewall, disarm только после подтверждения. Не закрывать доступ на основании Self.Online или бессрочного marker.

**Приёмка:** VM с provider console: потеря процесса/SSH до и после cutover, timer реально восстанавливает доступ, reboot в окне rollback, неправильный candidate, отказ owner, custom port/Match/includes, IPv6 и socket activation.

### AF-10 — P1 — Чистому VPS неоткуда получить обязательные pinned packages [S, 99%]

Исходники на проверенном commit: [setup/src/stages/docker.ts:27](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/docker.ts#L27); [setup/src/stages/system.ts:35](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/system.ts#L35).

**Код:** `stages/system.ts:plannedPinsFromObservation`; `stages/access.ts:installPinnedTailscale`; `stages/docker.ts:plan`; `adapters/docker.ts:observe`; `versions.lock.json`.

Docker/Tailscale ожидают уже настроенные apt sources/candidates. Реального шага установки официального signed repository/keyring нет. Версии Docker и Tailscale берутся из candidate metadata вместо обязательного release lock; fixture busybox задан mutable tag `1.36.1`. S02 supervised не включает ufw, хотя следующий S03 зависит от firewall. Apt simulation не является полной проверкой безопасного изменения зависимостей; bootstrap apt path не соответствует всей bounded/fail-closed модели.

**Исправление:** явно автоматизированный gated repo/keyring bootstrap с проверкой trusted keys либо обязательный конкретный ручной шаг. Pins из validated lock, candidate только для availability; missing pin → blocked. Simulation оценивать на remove/downgrade/conflicts, post-observe package metadata/versions; подписи/TLS failures без fallback. Не считать строку «official repository» доказательством origin.

**Приёмка:** fresh Ubuntu без third-party repo, stale/partial apt metadata, wrong key, unavailable exact version, dpkg lock/interruption, installed newer/older package, foreign Docker workloads. Не удалять locks и не убивать dpkg автоматически.

### AF-11 — P1 — Setup release не исполняется вне checkout [R/S, 100%]

Исходники на проверенном commit: [setup/release/build-release.mjs:146](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/release/build-release.mjs#L146); [setup/release/build-release.mjs:211](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/release/build-release.mjs#L211).

**Код:** `release/build-release.mjs:main,copyRecursive`; `release/verify-release.mjs`; `../../.github/workflows/setup-checks.yml`.

1. Документированный `npm --prefix setup run release:build` запускает script с cwd=setup, но script ищет `<cwd>/setup/dist`, то есть setup/setup. Воспроизведён отказ `missing setup/dist/src/cli.js` при существующей сборке.
2. В архив не копируются runtime node_modules и нет bundling. Изолированная распаковка: CLI падает `Cannot find module 'ajv/dist/2020'`.
3. release-manifest создаётся ПОСЛЕ tar; его нет в архиве. Это может быть external envelope, но сейчас документация и verification не оформляют такой trust contract.
4. Обещанные sort/owner/group/mtime reproducibility flags в tar отсутствуют; тест с названием reproducible делает одну сборку, а не сравнение двух.
5. source_commit проверяется по regex, но payload берётся из рабочей директории; нет доказательства соответствия commit. Keyring принимается по существованию. CI использует placeholder keyring.

**Исправление:** root от import.meta.url; production dependencies или bundle без npm на host; подписанный payload inventory и отдельно корректный archive envelope без циклического self-hash; exact source checkout/dirty-tree guard; hermetic reproducibility; real key trust и provenance pins; candidate/qualified статусы. Archive verifier должен учитывать типы entries, links, дубликаты, размеры и signed manifest, не только pathname strings.

**Приёмка:** build из repo root/setup/чужого cwd; две независимые сборки дают одинаковый payload/archive по заявленной модели; extract в пустую среду без соседних node_modules → CLI работает; invalid/missing keyring, stale dist, extra file, изменённый payload отвергаются.

### AF-12 — P1 — Bootstrap не устойчив к cwd и опасным path characters [S, 99%]

Исходники на проверенном commit: [setup/bootstrap.sh:333](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/bootstrap.sh#L333); [setup/bootstrap.sh:504](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/bootstrap.sh#L504).

**Код:** `bootstrap.sh:CLI_ENTRY_PATH,verify_existing_node,launcher_tmp`.

`--release-dir .` разрешён и рекомендован в USER MANUAL, но launcher записывает относительный путь. После смены cwd он перестаёт находить CLI. Переданный release-dir/HOME вставляется в shell source launcher без корректного shell quoting: кавычки/command substitutions в имени каталога становятся частью исполняемого текста. Matching Node определяется marker hash и `--version`, а не actual binary hash. Нет общей защиты bootstrap от concurrent invocation и полного восстановления staging после kill. Проверка URL только на https, доверенность и происхождение всего release-dir предполагаются внешними.

Дополнительные исходники: [setup/bootstrap.sh:31](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/bootstrap.sh#L31); [setup/bootstrap.sh:94](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/bootstrap.sh#L94).

**Дополнение после независимой сверки:** Bootstrap сохраняет исходный PATH; prefix allowlist допускает `/usr/local/*`, а часть утилит (`basename`, `tr`, `tail`, `rm`, `date` и др.) вызывается без trusted resolution. Сбросить PATH до первого внешнего вызова и проверять реальное разрешение/ownership executable; один префикс не доказывает доверенность. `json_escape` экранирует только backslash/quote, не все JSON control characters: использовать корректное кодирование либо заранее отклонять неподдерживаемые символы. Launcher должен ссылаться на устойчиво установленный проверенный payload, не на произвольный распакованный временный каталог.

Уточнение к EXT-AF-106: C12 прямо допускает bootstrap из *уже проверенной* release-папки; отсутствие второй проверки подписи внутри bash само по себе не отдельная уязвимость, если обязательная внешняя проверка и её trust root действительно работают. Требование сохранить проверенные bytes/identity остаётся. Порог 60 s для Node download сам по себе не доказывает нарушение правила 30 min, заданного для крупных image/model transfers; проверять общий deadline/retry semantics, не механически увеличивать таймаут.

**Исправление:** canonical absolute release root; безопасное кодирование shell argv, ограничение control chars; durable release ownership/receipt validation, фактическая проверка установленного binary/payload; bootstrap lock и recoverable staging. Trust root/key fingerprint получать независимо от скачанного пакета. TLS/integrity failure должны возвращать security code и не retry.

**Приёмка:** `--release-dir .` и пути с пробелами/кавычками/долларом, последующий запуск из /tmp, modified node with same version marker, simultaneous bootstrap, interruption и full disk. Никаких скрытых sudo env bypass в release build.

### AF-13 — P1 — Installer и реальный M0 несовместимы по manifest, policy и probes [S, 100%]

Исходники на проверенном commit: [setup/schemas/application-manifest.schema.json:57](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/schemas/application-manifest.schema.json#L57); [setup/src/stages/configuration.ts:139](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/configuration.ts#L139); [app/m0-02-runner/runner.ts:393](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/app/m0-02-runner/runner.ts#L393).

**Код:** `schemas/application-manifest.schema.json`; `../../app/m0-03-release/deployment-manifest.json`; `stages/auth.ts:resolveRunnerVerifyCommand`; `stages/configuration.ts:canonicalPolicyObject`; `adapters/git.ts:probeCommands`; `app/m0-02-runner/runner.ts,verify.mjs`.

Installer schema требует runner_verify и запрещает runner_run/runner_status/verify_fake. M0 имеет именно последние ключи согласно исходному CONTRACT C13. S06 policy не содержит `image`, `timeout_seconds`, `daily_runs`, которые обязательны реальному runner. Fake verifier M0 не принимает installer output contract/--output и не создаёт ожидаемый smoke JSON. M0 archive не содержит ajv runtime package. Аргументы runner с `--experimental-strip-types` оставляют runner.ts относительным; process adapter не задаёт cwd. Probe `runner_stop --help` опасен: у M0 обработчик stop не разбирает help и реально пишет PAUSED/удаляет контейнеры при достижении этого пути.

Дополнительные исходники: [setup/src/adapters/git.ts:426](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/adapters/git.ts#L426); [setup/src/stages/service.ts:117](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/service.ts#L117).

**Дополнение после независимой сверки:** Приёмка из EXT-AF-005 (`runner.ts status`) недостаточна: status не разбирает policy. Локально при `policy-level1.json={}` status вернул exit 0; отсутствие Docker обработано отдельно. Проверять реальный parse/run path с безопасным fake Docker, затем интеграцию на VM.

S05 отдельно хеширует/перечисляет архив, затем позднее распаковывает исходный mutable path. Fresh observe в apply уже есть, но оно не закрывает окно *после* проверки; extraction и content verification не доказывают равенство полного inventory. Разбор человекочитаемого `tar -t/-tv` не годится как единственный security parser. `--no-same-owner` и `--no-same-permissions` УЖЕ присутствуют — отсутствие этих флагов не находка. Нужны безопасно закреплённые проверенные bytes, bounded structured archive parsing, запрет links/devices/duplicates/escape/control names и равенство inventory до materialization/probes. `resolveCommandArgv` service допускает произвольный абсолютный executable и traversal у script args; absolute path не равен trusted release command. Держать binary/script/argv в reviewed capability allowlist и release confinement.

Тесты дополнить archive swap после observe, extra unlisted file, newline/duplicate/hardlink entries, script `../outside.js`, absolute `/bin/sh` вместо capability. Выполнение host command из manifest допустимо только для доверенного проверенного application release после code-trust gate, никогда как probe неподтверждённого артефакта.

**Исправление:** canonical C13 manifest + explicit compatibility adapter, единый validated policy, offline verifier protocol, bundled app dependencies. Help/probe не должен выполнять stop. Разделить read-only capability probe и настоящую mutation. Нельзя «исправить» контракт одной подменой названий в тестовых fixtures.

**Приёмка:** именно собранный M0 archive проходит S05/S06/S07; no fake stand-in manifest; help/status не меняют state/containers; runner запускается из любого cwd через adapter; отрицательные runtime scenarios отражаются в setup outcome.

### AF-14 — P1 — Process/HTTP adapters нарушают cwd, timeout и output contracts [R/S, 99%]

Исходники на проверенном commit: [setup/src/adapters/process.ts:74](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/adapters/process.ts#L74); [setup/src/adapters/systemd.ts:210](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/adapters/systemd.ts#L210).

**Код:** `adapters/process.ts:NodeProcessAdapter.runCommand`; `adapters/systemd.ts:runAppCommand`; `adapters/http.ts`.

Process options не имеют cwd/stdin/TTY/cancellation contract. Systemd принимает cwd, но теряет его при вызове process adapter (воспроизведено). Timeout убивает только direct child, не process group; descendants могут продолжать mutation/удерживать pipes. На output overflow buffer продолжает расти, посылается TERM без отдельного bounded completion, а размер ограничивается только в финальном результате. Та же timeout политика применяется к apt. HTTP timeout создаёт Error без retryable code; total deadline не ограничивает каждую request/sleep; HTTPS-only artifact trust не выражен типом.

Дополнительные исходники: [setup/src/adapters/process.ts:150](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/adapters/process.ts#L150); [setup/schemas/state.schema.json:39](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/schemas/state.schema.json#L39).

**Дополнение после независимой сверки:** Process env не задаёт явный `LC_ALL=C` и noninteractive режим apt; определить их для соответствующих execution classes и проверить, что apt не ждёт ввода при закрытом stdin. Отсутствие LANG само по себе ещё не доказывает ошибку локали. Текстовый суффикс `...[truncated]` уже есть, но отсутствует структурированный outcome `output_limit_exceeded`/признак причины остановки — замечание «вывод вообще не помечен» слишком широко.

`bootId()` при read failure возвращает `unknown-boot-id`, несовместимый с UUID pattern state schema; `machineIdHash()` хеширует одинаковый fallback `unknown-machine-id`. Нельзя продолжать запись/допуск с выдуманной identity. До mutations вернуть typed unsupported/blocked, сохранить старый state; тестировать отсутствующие, некорректные и непрочитанные host identity files. Не добавлять этот fallback в schema как допустимую identity.

**Исправление:** отдельные execution classes для read-only/normal mutation/apt/interactive auth; cwd/env allowlist, stream byte limits до accumulation, abort/process group tracking, TERM→KILL с cleanup evidence для допускающих это операций. Для apt — safe interrupt/reconcile protocol. HTTP exact deadline+bounded retries+typed errors+scheme/source policy; не логировать сырые чувствительные args.

**Приёмка:** child forks, ignores TERM, holds stdout, emits huge/no-newline stream, spawn ENOENT, lost cwd, HTTP slow stream/429/Retry-After/TLS/timeout, apt interruption без orphan dpkg.

### AF-15 — P1 — S06 image build и runtime command расходятся [R/S, 99%]

Исходники на проверенном commit: [setup/src/stages/configuration.ts:169](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/configuration.ts#L169); [setup/src/stages/configuration.ts:1097](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/configuration.ts#L1097); [setup/src/stages/configuration.ts:1028](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/configuration.ts#L1028).

**Код:** `stages/configuration.ts:buildContextFiles,buildPinnedAgentImage,ensureToyFixture`; `templates/config/agent.Dockerfile`; `versions.lock.json`; `../../app/m0-02-runner/runner.ts`.

Base image передаётся как bare `sha256:...`, а не полный `repository@sha256:...`; contract не обеспечивает локальное наличие образа. Base и agent digests в lock совпадают, хотя образ меняется установкой Codex. После локальной сборки требуется RepoDigest, который не обязан существовать у local build. ENTRYPOINT=codex конфликтует с runner command `timeout ... codex ...`: получится вызов codex с аргументом timeout, а не timeout как процесс. Ожидаемый tarball SRI передан неработающим npm `--integrity` flag; bytes не сверяются с этим expected digest (дополнительное воспроизведение ниже). При повторном S06 `git commit --allow-empty` создаёт новый fixture SHA даже без изменения файлов.

Дополнительные исходники: [setup/templates/config/agent.Dockerfile:5](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/templates/config/agent.Dockerfile#L5).

**Дополнение после независимой сверки:** **Новый локальный факт [R]:** npm 11.9.0 с заведомо неверным `--integrity=sha512-AAA…` успешно установил собственный безвредный local tarball offline (`--ignore-scripts`). Он выдал `Unknown cli config "--integrity"`, exit 0; записанный lock integrity отличался от ожидаемого. Контроль: тот же неверный digest в `../../package-lock.json` + `npm ci` с пустым cache дал exit 1 / `EINTEGRITY`. Следовательно, используемый Dockerfile flag не является проверкой ожидаемого SRI. Это проверка CLI-механизма на локальном fixture, не запуск настоящего Codex image build.

Использовать проверяемый lock с полной dependency graph либо прямую проверку tarball bytes; негативный SRI-тест обязан падать до установки. Default template также не обеспечивает наличие Node/npm и non-root image user. Проверять реальный toolchain/native executable, effective runtime UID и совместимость auth ownership; не назначать произвольный UID 10001 без согласования с bind-mount UID/GID.

**Исправление:** выбрать один явный путь: reviewed OCI artifact по полному ref+platform digest или reviewed deterministic recipe с локальным image ID + recipe/lock evidence; не смешивать ID/manifest digest. Проверить actual installed CLI/native dependencies/entrypoint и integrity. Fixture identity не меняется при втором запуске.

**Приёмка:** реальный disposable Docker build/run без credentials, command/entrypoint test, wrong digest/SRI/platform, missing native binary, second-run same SHA/policy/image identity. Не придумывать новые хеши.

### AF-16 — P1 — OAuth login не может работать как реализовано [S, 100%]

Исходники на проверенном commit: [setup/src/stages/auth.ts:544](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/auth.ts#L544); [setup/src/stages/auth.ts:340](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/auth.ts#L340).

**Код:** `stages/auth.ts:runAuthLogin,authPresence`; `adapters/process.ts`.

Docker запускается с `--interactive --tty`, но host stdin игнорируется, stdout/stderr захватываются, device code не показывается интерактивно. `--network none` не даёт выполнять OAuth exchange. Auth path примонтирован как /auth, но workflow полагается на `login --auth-dir`, совместимость которого с pinned CLI не доказана. Наличие любого файла в auth каталоге считается authenticated; CLI сообщает `auth_present: true` даже без проверки содержательного результата. Нет единого permission/owner guard при этом entrypoint.

Дополнительные исходники: [setup/src/stages/auth.ts:551](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/auth.ts#L551).

**Дополнение после независимой сверки:** Login не передаёт `--user`; у показанного Ubuntu-based Dockerfile нет USER. После исправления сети/TTY auth-файлы могут оказаться root-owned и недоступны runner с `--user uid:gid`. Требовать согласованный effective UID/GID в login/run, 0700/0600 и фактический доступ. Read-only auth mount может мешать refresh; подтвердить поведение pinned CLI и определить отдельный owner-controlled refresh flow. Не давать недоверенному Worker бесконтрольную обратную запись tokens в host auth.

**Исправление:** отдельная проверенная процедура auth для pinned CLI: owner TTY/device flow, минимально необходимая сеть, CODEX_HOME/credential path согласно реально проверенному интерфейсу; device code только TTY, не logs/JSON. Разделить credential_present и authentication_verified. Auth permission checks до mount, отсутствие credential → не success.

**Приёмка:** cancelled/expired OAuth, no TTY, no network, empty/junk auth dir, wrong owner/mode, token refresh; fake тесты плюс один явно одобренный live owner test отдельно.

### AF-17 — P0 — Live smoke разрешает повтор после неизвестного результата [S, 99%]

Исходники на проверенном commit: [setup/src/stages/auth.ts:352](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/auth.ts#L352); [setup/src/stages/auth.ts:617](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/auth.ts#L617).

**Код:** `stages/auth.ts:approvedGate,runSmokeCommand,executeRunnerVerify`.

Gate проверяется по id/status/expiry без active plan/config/resource hash. Existing live intent не проверяется перед записью нового; previous unknown_usage не запрещает следующий вызов. Один и тот же output path используется повторно без удаления/уникального operation binding. Result provider/fixture/run id не сравниваются строго с ожидаемым invocation; достаточно подходящих status/SHA. Несколько smoke процессов не сериализованы. Quota approval не задаёт реально enforced бюджет.

**Исправление:** atomically reserve operation/budget после approvals; prior intent/unknown → reconcile/blocked, без автоматического retry. Fresh output directory с nonce, trusted terminal result и обязательной identity/provider binding. Одноразовые live approvals на конкретный вызов; credentials/permissions/S07 proof перепроверять.

**Приёмка:** kill после отправки, до receipt; два одновременных smoke; stale result, fake result при live, old approved gate; ни один сценарий не создаёт скрытого повторного model call.

### AF-18 — P0 — Restore выполняется без специального approval [S, 100%]

Исходники на проверенном commit: [setup/src/core/engine.ts:815](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/core/engine.ts#L815).

**Код:** `core/engine.ts:runRestore`.

Restore принимает любой schema-valid plan с совпадающим config hash. Он не проверяет, что план описывает restore именно backup-id и конкретных targets, не вызывает gate verifier и не получает lock. Обычный preflight plan достаточен для входа в destructive restore.

**Исправление:** отдельная типизированная restore operation, backup content hash/ID/targets/current-state binding, explicit restore gate, lock, paused/drained application, pre-restore backup, plan expiry. Ни один общий флаг/обычный план не заменяет это.

**Приёмка:** preflight plan, чужой backup ID, unapproved/expired restore, active worker, concurrent backup/update → отказ до первой записи.

### AF-19 — P0 — Restore обходит symlink и целостность payload [R/S, 100%]

Исходники на проверенном commit: [setup/src/operations/restore.ts:28](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/operations/restore.ts#L28); [setup/src/operations/backup.ts:544](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/operations/backup.ts#L544); [setup/src/operations/backup.ts:378](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/operations/backup.ts#L378).

**Код:** `operations/restore.ts:ensurePathNotSymlink,copyTree,restoreBackup`; `operations/backup.ts:verifyBackup,readManifest,pruneOwnedRetention`.

`ensurePathNotSymlink` ловит собственную security exception и возвращается без ошибки. Verify проверяет только перечисленные manifest entries, restore копирует весь payload, включая неперечисленные файлы. Manifest допускает пустой entries; backup_id/archive_path не имеют полного confinement/schema. Retention удаляет путь, построенный из backup_id из manifest, а не проверенного имени принадлежащего каталога. Destination leaves в copyTree также могут быть symlinks.

**Воспроизведение:** manifest с `entries: []`, неперечисленный state/unlisted.txt и application_state_dir→temp victim. Restore успешно записал `RESTORED_UNVERIFIED` в victim. Всё внутри /tmp, никаких системных файлов.

**Дополнение после независимой сверки:** Hash-манифест рядом с payload обнаруживает случайное повреждение только при доверенном манифесте: одновременная замена обоих не доказывает authenticity. Restore gate должен связываться с ранее проверенной identity/digest конкретного backup и targets вне mutable payload, с повторной сверкой перед записью. Для локальных owner-owned backups это не повод автоматически вводить PKI; отдельно определить угрозы corruption, подмены imported backup и враждебного same-UID process. Последний нельзя устранить записью ещё одного digest в тот же owner-writable state.

**Исправление:** catch только ENOENT; path confinement для ID и entries, lstat/O_NOFOLLOW на parent/leaf, отказ links/special files; полный inventory equality payload↔manifest; копировать только проверенные bytes; retention только по observed owned directory identity, не arbitrary manifest path.

**Приёмка:** extra/missing/duplicate/traversal entry, empty fake manifest, symlink parent/leaf, malicious backup_id, root escape, concurrent swap; ни одного изменения вне owned target и ни одного непроверенного восстановленного файла.

### AF-20 — P1 — Backup/restore не образуют согласованный recovery snapshot [S, 99%]

Исходники на проверенном commit: [setup/src/operations/backup.ts:444](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/operations/backup.ts#L444); [setup/src/operations/restore.ts:119](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/operations/restore.ts#L119).

**Код:** `operations/backup.ts:createBackup,verifyBackup,resolveServiceDbPath`; `operations/restore.ts:restoreBackup,preserveUnknownUsage`; `stages/service.ts:apply`.

Backup копирует app/state, игнорируя отдельный configured application_state_dir, и не гарантирует quiescence. Unknown usage сохраняется в app/state/live-smoke.json, тогда как реальный S08 пишет setup_state/s08-live-smoke.json и intent. Restore накладывает файлы поверх существующих, не даёт транзакционного переключения, может оставить смесь поколений; PAUSED ставится лишь в конце. Service DB перезаписывается без безопасного WAL/SHM lifecycle. S10 использует cp main SQLite file после pause без доказательства drain/checkpoint/consistent backup. Нет надёжного соответствия restored DB, app binary и policy.

Дополнительные исходники: [setup/src/operations/backup.ts:10](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/operations/backup.ts#L10); [setup/src/operations/backup.ts:628](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/operations/backup.ts#L628); [docs/automation/CONTRACT.md:130](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/docs/automation/CONTRACT.md#L130).

**Дополнение после независимой сверки:** C13 обещает `operations.retention_days/backup_path`, но текущая schema/types таких sections не поддерживают, а `pruneOwnedRetention` всегда берёт 14 дней и фиксированный root. Точнее говорить о нереализованном config contract, а не о прочитанном, но проигнорированном поле. Реализовать validated options с сохранением последней действительно проверенной копии. Убрать production `FACTORY_SERVICE_DB_PATH` как обход typed/config-bound restore target; DI тестов оставить вне production input. Добавить тесты нескольких retention values, неподтверждённого latest backup и отсутствия влияния env на restore target.

**Исправление:** единый state layout и accounting authority; snapshot после реального pause/drain, SQLite backup API/проверенная app backup capability, WAL-aware restore в staging при stopped service, paired release/schema compatibility; PAUSED до mutations и после любого сбоя; сохранить current usage reservations и unknown intents, не откатывать budget назад. Восстановление предыдущего поколения при частичном failure.

**Приёмка:** backup активного writer, WAL committed data, failure посередине restore, отдельный state_dir, неизвестный live расход, новый backup corrupt при старом valid, restore несовместимого binary/schema.

### AF-21 — P0 — Runner не ограничивает writable output во время выполнения [S, 99%]

Исходники на проверенном commit: [app/m0-02-runner/runner.ts:535](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/app/m0-02-runner/runner.ts#L535); [app/m0-02-runner/runner.ts:582](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/app/m0-02-runner/runner.ts#L582).

**Код:** `app/m0-02-runner/runner.ts:runCommand,handleLogChunk,directorySizeBytes`.

/out — writable host bind без volume quota. Размер проверяется после завершения контейнера: процесс может заполнить host disk до проверки. Ошибки append/write из stream callbacks могут аварийно завершить host runner без гарантированного container cleanup. Внешний finally удаляет lock только при containerRemoved, но не является universal cleanup. Post-exit directory traversal тоже не имеет file-count/depth bound. Docker daemon log retention полагается на отдельную настройку host.

Дополнительные исходники: [app/m0-02-runner/runner.ts:413](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/app/m0-02-runner/runner.ts#L413).

**Дополнение после независимой сверки:** Отдельный app runner lock также не восстанавливается: `active.lock` содержит PID, но не boot ID/start ticks; `run` прекращается по одному exists до проверки residual containers. В безопасном локальном тесте файл с заведомо несуществующим PID дал `Error: active.lock exists`; CLI recover для этого lock отсутствует. Не путать его с installer lock AF-06. Добавить owner-driven recovery: проверить identity старого процесса и конкретные owned containers, сохранить unknown model usage/PAUSED, quarantine только доказанно stale lock. Простое удаление файла и автоматический повтор live run запрещены. Нужны kill/reboot/PID reuse/orphan/unknown usage тесты, включая отсутствие скрытого второго model call.

**Исправление:** реально bounded output storage (выбранное технически доказанное решение, например ограниченный tmpfs внутри container с controlled bounded export после завершения либо quota-managed volume), runtime monitoring как дополнительная защита, максимум файлов/inodes/depth; centralized cleanup в finally на каждый path, включая fs failures. Неподтверждённый cleanup → PAUSED + durable interrupted receipt.

**Приёмка:** output flood, many small files, huge sparse file, log ENOSPC, result parse failure, daemon disconnect, SIGINT/SIGTERM и host-side exception. Реальный Docker quota test обязателен отдельно.

### AF-22 — P0 — Runner не защищает границу project/control/credentials [S, 98%]

Исходники на проверенном commit: [app/m0-02-runner/runner.ts:420](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/app/m0-02-runner/runner.ts#L420); [setup/src/core/validators.ts:76](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/core/validators.ts#L76).

**Код:** `app/m0-02-runner/runner.ts:runCommand`; `../../setup/src/core/validators.ts`; `stages/configuration.ts:path safety`.

Runner принимает произвольный repo path, без global disjointness с factory/setup/auth/home и без admission public-owned/toy scope. Clean git status не доказывает отсутствие ignored секретов: host directory примонтирован целиком вместе с .git/config и ignored файлами. `git`/`docker` запускаются через PATH с унаследованным env, локальный git config может включать executable helpers. Credentials доступны Worker при unrestricted bridge network — это известный допустимый только supervised риск, но код не обеспечивает отдельное scope admission и может случайно применяться к неподходящему checkout.

**Исправление:** канонический allowlisted worktree/export exact SHA, исключить ignored/control/credential files и пересекающиеся корни; отдельная политика .git metadata; trusted binaries/minimal env/git config isolation. Supervised credential exposure подтверждается явно на узком scope; unattended требует M2 broker+egress evidence и остаётся blocked. Не объявлять read-only mount защитой от чтения/утечки.

**Приёмка:** repo=app/home/auth, nested paths/symlink parents, ignored .env, URL token в .git/config, local git helper, malicious PATH, попытка менять policy и обращаться к Docker socket; secrets не попадают в Worker/export/logs.

### AF-23 — P1 — Ownership labels несовместимы; stop затрагивает чужие runs [S, 100%]

Исходники на проверенном commit: [app/m0-02-runner/runner.ts:63](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/app/m0-02-runner/runner.ts#L63); [setup/src/operations/emergency.ts:112](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/operations/emergency.ts#L112); [setup/src/stages/verification.ts:12](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/verification.ts#L12).

**Код:** `app/m0-02-runner/runner.ts:runnerLabel,stopCommand`; `operations/emergency.ts:isOwnedContainer`; `stages/operations.ts`; `stages/configuration.ts`; `stages/verification.ts:validateNoSecretDockerBoundary`.

Runner использует общий `agent-factory=level1` и run-id; installer emergency ожидает `agent-factory.installation_id`; часть setup пишет `agent-factory.installation-id`. M0 stop удаляет все контейнеры с общим label, не только текущей installation. S07 имеет глобальное фиксированное имя без installation/operation labels. Help probe stop усиливает риск AF-13.

**Исправление:** один shared ownership contract; installation UUID + operation UUID + role, проверять labels по immutable container ID перед mutation; ambiguity reconciliation; stop не удаляет чужие installation resources, даже если name похож.

**Приёмка:** две installations и foreign container с похожим label/name; crash между create и receipt; stale inventory; только подтверждённо owned resources остановлены/удалены.

### AF-24 — P0 — Service admission и rollback недостаточно строгие [S, 99%]

Исходники на проверенном commit: [setup/src/stages/service.ts:370](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/service.ts#L370); [setup/src/adapters/systemd.ts:195](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/adapters/systemd.ts#L195).

**Код:** `stages/service.ts:snapshot,renderUnitTemplate,apply,rollbackService`; `adapters/systemd.ts`; `templates/systemd/agent-factory.service`.

Проверка paused — regex `/paused/i`: JSON `{"paused":false}` или строка `not paused` пройдут. Существующий unit признаётся по active/enabled без digest/effective ExecStart/User/drop-ins. Root cp -a сохраняет writable ownership release. Unit перезаписывается без гарантированного paired backup старого unit/enabled state. Node executable остаётся из home владельца. systemd command rendering использует shell escaping, хотя systemd имеет собственные quoting/specifier semantics. Pause не равно подтверждённому drain. M2 admission основано на локальном evidence JSON и совпадении ссылок, а не перепроверке bind к текущему release/security profile.

Дополнительные исходники: [setup/templates/systemd/agent-factory.service:20](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/templates/systemd/agent-factory.service#L20); [setup/templates/systemd/backup.service:8](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/templates/systemd/backup.service#L8); [setup/src/stages/service.ts:303](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/service.ts#L303).

**Дополнение после независимой сверки:** Расширены service requirements. Шаблон отстаёт от guide: нет `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths`, `MemoryMax` и `OOMScoreAdjust`; отсутствует явная зависимость от Docker. Согласовать confinement и resource settings с реальными writable paths/capabilities, проверить service и backup units через systemd 255. Дополнительные CapabilityBoundingSet/RestrictAddressFamilies/SystemCallFilter применять по совместимости, не ради формального score. Unit с доступом к rootful Docker socket всё равно доверенная административная часть.

`backup.service` содержит `User={{USER}}`: вызов user-writable launcher — проблема неизменности доверенного кода, но НЕ сам по себе доказанное выполнение от root. Использовать проверенный immutable executable/payload для unattended jobs; не запускать backup как root ради обхода прав.

Приложенный newline PoC проверен `systemd-analyze verify` 255: exit 1, `Unbalanced quoting`, unit не запустится. Не заявлять успешную directive injection/root-RCE. Ошибка shell-style quoting и интерпретация `%`/`$` остаются: reject control chars, реализовать systemd-specific escaping, тестировать реальные argv/paths, а не только успешный parse. Самодельный application `--emit-evidence` не становится доверенным M2 proof без независимой provenance/content/host binding.

**Исправление:** строгий typed app status (`paused === true`, active work = 0), effective systemd properties+config hashes, service account/code ownership isolation, поддерживаемый node path, correct systemd escaping/control-char rejection. Existing foreign/drifted unit → proposal/manual gate. Backup/restore unit, DB и binary как единый transition; recovery сохраняет paused. M1/M2 отсутствие не компенсировать mocks.

**Приёмка:** paused=false, active workers, foreign unit/drop-in, user-writable release, failed start/reload/migration/rollback, reboot halfway. Unit выполняет именно reviewed code от ожидаемого UID.

### AF-25 — P0 — Update может принять переключение symlink за успешное обновление [S, 99%]

Исходники на проверенном commit: [setup/src/operations/update.ts:671](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/operations/update.ts#L671); [setup/src/operations/update.ts:451](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/operations/update.ts#L451).

**Код:** `operations/update.ts:validateCommand,assertApprovals,ensureReleasePath,applyUpdate,rollbackAfterFailure`; `core/engine.ts`; `stages/update.ts`.

Существование каталога и строковые поля release не доказывают hashes/immutability. Approvals продублированы бессрочными booleans в отдельном manifest. Commands могут быть произвольными absolute binaries/argv; запрет подстроки `git pull` не запрещает argv `['/usr/bin/git','pull']` и не создаёт trust boundary. При orphan switched release создаётся success receipt без проверки migration/start/health. Rollback может переключить old symlink и вызвать тот же restart command, не привязанный к old release. Backup мог быть создан задолго до drain. CLI `update plan|apply --release` вообще не подключён.

**Исправление:** dedicated update verbs, только trusted capability commands из проверенного old/new release, exact provenance/content/schema and backup freshness binding; per-operation durable phases; после orphan переключения полноценная проверка текущего binary/DB/paused state, иначе interrupted. Rollback old code+совместимая DB или paired restore по явной матрице.

**Приёмка:** kill после migrate/switch/restart до receipt, partially applied migration, tampered release, stale backup, unsupported rollback, unknown outcome. Смена current сама по себе не даёт verified.

### AF-26 — P1 — Inference сообщает health без модели/API проверки [R/S, 100%]

Исходники на проверенном commit: [setup/src/stages/inference.ts:558](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/inference.ts#L558); [setup/src/stages/inference.ts:746](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/inference.ts#L746).

**Код:** `stages/inference.ts:observeResources,stageModelAndStartServing,writeHealthAndState`; `templates/compose/inference.yaml`.

`df -Pi --output=iavail,target` несовместим: воспроизведено `options -i and --output are mutually exclusive`. Реальный adapter делает compose pull image/up, но не скачивает pinned model, не сверяет inventory/model digest/API. После running-container check записывает `health_ok: true` и desired model digest как observed. Шаблон задаёт фиксированные cpus/memory, не всю validated resource profile; service/volume names могут конфликтовать между installations. Env mutation switch и non-enforcing preconditions остаются.

Дополнительные исходники: [setup/src/stages/inference.ts:209](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/inference.ts#L209); [setup/src/stages/inference.ts:544](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/inference.ts#L544).

**Дополнение после независимой сверки:** RAM guard уже существует: берётся положительный `pins.resources.min_ram_bytes`, иначе 16 GiB. Поэтому «RAM вообще не проверяется» неверно. Но произвольно низкий positive pin может ослабить admission при template `memory: 10g`; нужен minimum approved profile/model budget + host reserve, schema чисел и согласование с compose limits. Проверить отказ 8 GiB для заявленного профиля и невозможность обхода заниженным pin. Фиксированное универсальное 12 GiB из второго аудита не переносить без расчёта/qualification конкретной модели.

Порт определяется текстовым поиском wildcard addresses в docker output: дополнить структурированным PortBindings и actual listener checks для IPv4/IPv6 и non-loopback конкретного IP. Наличие `wget` в pinned Ollama и доступность API/transfer при `internal:true` здесь не установлены; это обязательные VM acceptance cases, не подтверждённые факты. Использовать healthcheck с заведомо доступным инструментом и отдельный download/serving network lifecycle.

**Исправление:** исправить resource probes; staged model transfer с digest/size/architecture checks и bound, private network, actual readiness/API/inventory verification. Infra health отделить от M3 routing и generation probe. Health не записывать по desired values. Optional failure не влияет на cloud-only; небезопасный serving cleanup подтверждается.

**Приёмка:** fresh volume без модели, wrong digest, OOM/ENOSPC, running but unhealthy API, exposed port, disable/reboot, две installations, generation probe только explicit gate. M3 отсутствие не блокирует базовый supervised MVP.

### AF-27 — P1 — CLI/schema/quickstart не соответствуют нормативному контракту [S, 100%]

Исходники на проверенном commit: [setup/src/cli.ts:11](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/cli.ts#L11); [setup/src/core/config.ts:127](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/core/config.ts#L127).

**Код:** `cli.ts:parseArgs,asStageId`; `core/config.ts:initConfig`; обе копии CONTRACT C02/C13; `../../setup/docs/quickstart.md`; `AGENTS.md`.

Unknown options/positionals тихо игнорируются; `--stage S99` превращается в default selection, неправильный profile — в supervised. Нет update и inference probe routing. Init selected_stages=[S01], dummy zero release hashes, несоответствующие C13 поля/defaults; documented expected runner_ready_offline не достигается. AGENTS/README частично продолжают утверждать, что кода installer нет, implementation reports объявляют завершённое поведение, которого нет в production adapters.

Дополнительные исходники: [setup/src/cli.ts:97](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/cli.ts#L97); [docs/automation/START-HERE.ru.md:7](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/docs/automation/START-HERE.ru.md#L7).

**Дополнение после независимой сверки:** Дополнительно: CLI version захардкожена `0.0.1` (сейчас совпадает с package.json, будущий drift), `void main()` не имеет единого безопасного top-level error envelope. Version получать из release metadata, ошибки нормализовать без secret leakage. CONTRACT copies сейчас идентичны: это риск сопровождения, не уже состоявшееся расхождение. START-HERE требует отсутствующие `.github/copilot-instructions.md` и `.github/skills/implement-factory-setup/SKILL.md` — уточнить доставку starter package/обновить ссылки; добавить link check и проверку равенства/generation нормативных копий. Старый r4 guide пометить archival, не выдавать за актуальный источник.

**Исправление:** строгий parser с command-specific allowed/required args, ошибки до mutation; canonical schema/version/compatibility migration; default supervised S01–S07 без live, service с явными M1/M2 blockers. Пустые pins/релиз требуют setup input, не «валидные нули». Документы обновлять по исполняемым тестам. Не молча менять CONTRACT 1.0.0: сначала ADR на расхождения и явно согласуемая compatibility strategy.

**Приёмка:** typo stage/profile/verb/option, missing value, repeated conflicting flag; quickstart из чистого окружения соответствует точным commands/outcomes.

### AF-28 — P1 — Тесты не покрывают границы реальных компонентов [R/S, 100%]

Исходники на проверенном commit: [setup/tests/integration/core-engine.test.ts:118](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/tests/integration/core-engine.test.ts#L118); [setup/tests/vm/run-qualification.sh:23](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/tests/vm/run-qualification.sh#L23).

**Код:** `tests/integration/core-engine.test.ts`; `tests/integration/application.test.ts`; `tests/integration/release-packaging.test.ts`; `tests/vm/run-qualification.sh`; `../../.github/workflows/setup-checks.yml`; root package.json.

Engine tests используют synthetic stages и один engine; stage tests заранее вызывают plan в том же процессе. Release test не запускает распакованный CLI, не сравнивает два build и вызывает script напрямую из repo root, скрывая npm cwd bug. Root npm test не включает M0 verify.mjs. CI paths только setup, application tests отсутствуют. VM harness проверяет SSH/uname и печатает runbook: это не реализация failure matrix. NOT RUN в qualification документе честно отражает отсутствие VM proof; это нужно сохранить.

**Дополнение после независимой сверки:** Фраза второго аудита «все тесты — mocks, реальные adapters только apt» слишком категорична: существуют real filesystem/process-related проверки и release packaging tests. Проблема — именно разрыв существенных integration/security assertions, а не полное отсутствие немокового кода. Добавить shellcheck/actionlint и подходящий workflow security lint, systemd 255 rendered-unit checks; проверять meaningful assertions, не только зелёный lint/общий score. Root/setup/app paths должны запускать соответствующие jobs; actions pins и min permissions проверять централизованно.

**Исправление:** regression tests AF-01…31, subprocess CLI E2E с реальными stages и injected external boundaries, actual M0 artifact integration, isolated release tests, real adapter contract tests; root+setup+runner CI с минимальными permissions/pinned actions. Отдельный owner-authorized disposable VM suite со сценарием, assertions, evidence, status; никаких host tests в npm test.

**Приёмка:** каждый finding закрыт failing-before/passing-after test, release gates различают code-reviewed / offline-tested / VM-qualified / live-qualified. Не переименовывать отсутствие тестов в PASS.

### AF-29 — P1 — GitHub baseline/evidence не доказывают проверку проекта [S, 99%]

Исходники на проверенном commit: [setup/src/stages/project.ts:29](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/project.ts#L29); [setup/src/stages/project.ts:609](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/project.ts#L609).

**Код:** `stages/project.ts:FACTORY_BASELINE_TEMPLATE,NodeProjectStageAdapter.runChecker`; `templates/github/factory-baseline.yml`; `stages/platforms.ts`; `templates/github/factory-platform-check.yml`.

Baseline workflow только checkout/проверяет SHA/upload файлов, не запускает build/tests/guard. Это checkout evidence, не engineering baseline. Real checker возвращает unsupported/unknown (корректно не притворяется готовым). Collector evidence читается из локального файла; нужна чёткая доверенная цепочка от GitHub run/attempt/workflow SHA/checkout SHA, а не просто поля со строкой provenance. Inline `${{ inputs.target_sha }}` внутри shell вместо env создаёт injection surface для некорректного input. Browser smoke template остаётся blocked, что правильно; считать его работающим нельзя.

Дополнительные исходники: [setup/src/stages/project.ts:548](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/project.ts#L548).

**Дополнение после независимой сверки:** EXT-AF-212 проверен по всему `NodeProjectStageAdapter` и process/config interface: S09 строит HTTPS remote и вызывает `git fetch` без управляемого read-only credential adapter; process env не передаёт HOME/credential settings владельца. Поддерживаемый безопасный путь private-repo fetch не реализован/не описан. Это подтверждённый пробел интерфейса [S], а не доказательство, что fetch никогда не заработает с внешней system-wide настройкой git.

Выбрать явный documented public-only/blocked-private режим либо отдельный минимально привилегированный read-only adapter без передачи credential Worker/checker и без token в URL/log/config. Не «чинить» наследованием всего HOME/env. Тесты: public/private/401/403, истёкший credential, отсутствие токена в checkout/artifacts/logs и недоступность write/dispatch в read-only path. Реальный private GitHub request здесь NOT RUN. Старый Actions SHA сам по себе не доказывает CVE: проверять provenance/support/advisories и compatibility, не заменять на latest по возрасту.

**Исправление:** отделить checkout proof от baseline validation; подключить отдельно разработанный reviewed checker либо оставить explicit blocker. Strict SHA env validation до shell, official authenticated collector/verified manual import с целостностью evidence и exact binding; workflows min permissions, persist-credentials false и no secret target execution.

**Приёмка:** checkout success + failing tests не дают baseline pass; wrong workflow/run attempt/SHA/artifact, stale/manual evidence, malformed input, absent browser adapter — unknown/blocked, не pass.

### AF-30 — P1 — Secret-safe logging и permissions неполные [S, 98%]

Исходники на проверенном commit: [setup/src/adapters/process.ts:8](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/adapters/process.ts#L8); [setup/src/core/state.ts:161](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/core/state.ts#L161); [app/m0-02-runner/runner.ts:281](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/app/m0-02-runner/runner.ts#L281).

**Код:** `adapters/process.ts:sanitize`; `core/errors.ts:toSetupError`; `core/state.ts:appendEvent,readEvents`; `adapters/filesystem.ts`; `app/m0-02-runner/runner.ts:event,appendSanitizedLine`.

Installer sanitization покрывает часть токенов, не произвольные credential values/URL/password patterns. Runner сохраняет сырой provider stream после regex redaction, где произвольный секрет может остаться. Filesystem writeFile(mode0600) не исправляет mode существующего файла; appendFile не задаёт mode. Existing parent ownership/mode и symlink policy не проверяются повсеместно. Нет реализованной общей retention/cap для setup JSONL; appendEvent читает весь журнал на каждое событие, создавая рост затрат и памяти. Ошибки fs могут выводить unfiltered paths/данные в envelope.

**Исправление:** allowlisted structured events, bounded output и необязательный sanitized diagnostic export; не сохранять raw OAuth/provider stream по умолчанию; known-secret redaction только дополнительная защита. Enforce ownership/modes/no-links перед каждым чувствительным доступом; rotation+retention с сохранением незаменимого recovery evidence и bounded history reader.

**Приёмка:** synthetic secrets разных форм и chunk boundaries, URL credentials, private key multiline, existing 0644 files, shared/writable parents, ENOSPC/torn log, size/age rotation; credentials/device codes отсутствуют в stdout JSON/state/receipts/events/artifacts.

### AF-31 — P0 — S04 выдаёт недостоверное доказательство resource isolation [R/S, 100%]

Исходники на проверенном commit: [setup/src/adapters/docker.ts:775](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/adapters/docker.ts#L775); [setup/src/adapters/docker.ts:883](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/adapters/docker.ts#L883); [setup/src/stages/docker.ts:344](https://github.com/se-panfilov/agent-factory/blob/7d845248e7fcd089a36afc8b395b38c7226e09e7/setup/src/stages/docker.ts#L344).

**Код:** `NodeDockerAdapter.runPinnedResourceProbe`; `validateProbeResult`.

`cgroupApplied` равен `State.Running`, что не доказывает применение cgroup limits. Validator проверяет memory/pids только на `>0`, CPU — только на не-null, вместо сравнения с запрошенными 256 MiB/64/1 CPU. Network mode не задаётся и не проверяется; no-secret offline fixture может получить default bridge.

**Воспроизведение:** настоящий NodeDockerAdapter получил fake inspect с `NanoCpus=0`, `Memory=1 TiB`, `PidsLimit=999999`, `Running=true` и правильными labels/hardening flags. Его результат передан настоящему `createDockerStage.apply` через безопасный fixture adapter: получен успешный receipt. То есть тест проверил реальную decision logic, не настоящую работу Docker/cgroups.

**Поправка к EXT-AF-111:** `cleanupOk: true` выставляется только после успешного `docker rm -f`; ненулевой код/timeout УЖЕ вызывает ошибку. Нельзя называть это безусловным success независимо от cleanup. Недостаёт post-delete inspect по immutable container ID/labels и различения «absent»/«daemon unavailable»; после rm сейчас нет ни одного дополнительного probe. Условие отсутствия ресурсов после cleanup пока не подтверждается независимо.

**Исправление:** exact expected-vs-observed limits/security/network/image/ownership checks; cgroup enforcement — по actual cgroup evidence/безопасной bounded runtime probe, не Running. Fixture по digest, `network none` либо отдельно обоснованный минимальный режим. Cleanup в finally, resource identity сохраняется до завершения; absence подтверждается, unknown не превращается в успех и не запускает следующую mutation.

**Приёмка:** CPU=0, неверные memory/pids, Running=true без cgroup enforcement, неверный NetworkMode/labels/image, failed/ambiguous rm, daemon disconnect и orphan name/ID → не verified. На disposable VM отдельно подтвердить фактические memory/pids/CPU ограничения и удаление fixture; host Docker здесь NOT RUN.

## Что действительно сделано хорошо

- Есть разделение installer и application milestones; отсутствие M1/M2 не следует «чинить» созданием фиктивного orchestrator.
- TypeScript stages и отдельные adapters позволяют чинить систему постепенно, без переписывания в универсальный framework.
- Много негативных fake tests; несколько путей действительно отказывают при unsafe input.
- В основных process calls shell=false; нет автоматического sudoers editing или cloud provisioning.
- M0 применяет read-only rootfs, cap-drop, no-new-privileges, resource limits, чистый SHA и output schema validation. Эти меры полезны, но не заменяют исправления AF-21/22/23.
- Документирование NOT RUN для VM/live — правильное поведение. Удалять эти ограничения ради «зелёного релиза» нельзя.

## Приоритет исправлений

1. **Q1: core contracts и admission:** AF-01–07, AF-14, AF-27. Сначала новая нормальная сквозная модель; до этого не включать реальные mutations.
2. **Q2: privileged infrastructure:** AF-08–10, AF-12, AF-31. Проверяемые system adapters, настоящая защита доступа и root write boundary.
3. **Q3: настоящий offline MVP:** AF-11, AF-13, AF-15, AF-23. Setup archive + actual M0 archive + Docker offline run.
4. **Q4: supervision, secrets и recovery:** AF-16–22, AF-30. Live оставлять отключённым до acceptance.
5. **Q5: расширения:** AF-24–26, AF-29. M1/M2/M3/collector/checker отсутствие остаётся explicit blocker, а не препятствием offline MVP.
6. **Q6: итоговая квалификация:** AF-28 и regression tests всех групп. Реальные disposable VM и отдельный owner live test, затем решение о VPS.

Зависимости между пакетами последовательные; tests добавляются в каждом пакете, не только в конце. Не выдавать независимые параллельные задания на одни core files.

## Доказательства безопасных локальных воспроизведений

```text
Runtime: Node v24.19.0, npm 11.9.0
setup npm test: 81 passed, 0 failed
root npm test: 23 passed, 0 failed
root + setup typecheck: exit 0
M0 node verify.mjs: PASS (fake Docker only)

gate: before=approved, after= pending
fresh S05 apply: s05_config_not_initialized
verify invalid host: exit=0; S00=verified; S01=verified
state after injected ENOSPC: primary=false; previous=true
reload state: last_error=null
restore unlisted file through symlink: RESTORED_UNVERIFIED
NodeSystemdAdapter runAppCommand cwd: MISSING
isolated archive node_modules: false
isolated archive release-manifest.json: false
isolated CLI: exit=1, Cannot find module 'ajv/dist/2020'
npm release:build from documented invocation: missing setup/dist/src/cli.js
df -Pi --output=iavail,target: incompatible options
```

Локальные probes проверяют конкретные дефекты, а не весь production exploit chain. Возникшие self-test fixtures находятся только в аудиторской копии checkout, не в пользовательском репозитории.

## Неразрешённое и самопроверка

- Реальная эксплуатационная безопасность sudo, systemd, SSH/UFW, Docker, OAuth и Ollama не доказана до VM/live испытаний. Уверенность в наличии указанных дефектов высокая; вероятность конкретного ущерба в конфигурации пользователя не оценивалась.
- Доступность и authenticity каждого внешнего pin из versions.lock заново по сети не подтверждались. Аудит не объявляет эти hashes выдуманными; он показывает, где pins не используются/не привязаны к проверкам или имеют несовместимую семантику.
- Не выполнен полноценный dependency-CVE scan. Passing npm tests не означает отсутствие уязвимостей в зависимостях.
- Это глубокий аудит критических путей и их контрактов, а не формальное доказательство отсутствия иных дефектов. После исправления core следует повторный аудит diff и новая сквозная qualification; найденные сейчас ранние blockers маскируют более поздние проблемы.
- Главный системный риск: исправление одного раннего blocker открывает следующий опасный путь. Поэтому нельзя просто заставить gates пропускать apply и сразу запускать на VPS. Исправления admission, real adapter semantics и tests должны приниматься вместе.

## Сверка второго аудита: решения по каждому пункту

Входы: `AUDIT-agent-factory-7d84524 (1).md` (405 строк) и `poc.tgz`; тот же exact commit. Все PoC прочитаны до запуска. Нумерация `EXT-AF-*` ниже принадлежит внешнему отчёту. «Покрыто» означает совпадение с первой редакцией, «дополнено» — новую принятую деталь/проверку, «частично» — принятую основу с существенной поправкой. Это не новый подсчёт независимых уязвимостей.

| Внешний пункт | Решение и существенная поправка | Наши группы / ТЗ |
|---|---|---|
| EXT-AF-001 | Покрыто; добавлен единый clock. Блокируются gate-requiring paths, а не буквально любой вызов S02–S11. | AF-02 / Q1 |
| EXT-AF-002 | Покрыто: S03 no-op. Требуется реализация; до неё explicit blocked. | AF-09 / Q2 |
| EXT-AF-003 | Частично: binding/probes приняты; TTY/nonce не доказывают внешнее действие и не защищают от hostile same UID. | AF-07,09 / Q1–Q2 |
| EXT-AF-004 | Покрыто; C13 уже задаёт нормативные commands, не произвольный выбор схемы. | AF-13,27 / Q1,Q3 |
| EXT-AF-005 | Покрыто; предложенный `status` test НЕ проверяет policy. Это дополнительно воспроизведено. | AF-13 / Q3 |
| EXT-AF-006 | Покрыто; в qualification artifact также исключить локальные `/Users/...` paths и доказать isolated dependencies. | AF-11,13,30 / Q3,Q6 |
| EXT-AF-007 | Покрыто, два независимых release blockers воспроизведены ранее. | AF-11 / Q3 |
| EXT-AF-008 | Дополнено login UID/GID и token refresh. Флаги pinned Codex остаются NOT RUN до проверки конкретного бинарника. | AF-16 / Q4 |
| EXT-AF-009 | Усилено собственным offline SRI-тестом. Не требовать произвольный UID 10001 и бездоказательное обновление на latest. | AF-15 / Q3 |
| EXT-AF-010 | Покрыто. Пустой receipt сам по себе не универсальное доказательство провала: нужен typed mandatory verification result, including no-op. | AF-04–06 / Q1 |
| EXT-AF-011 | Покрыто/уточнено. Единый narrow privileged executor нужен; конкретное имя класса RootRunner и `sudo -v` как универсальная защита — нет. | AF-07 / Q1–Q2 |
| EXT-AF-101 | Покрыто; усилены validate-before-write/backup. User-owned 0700 staging недостаточно против процесса того же UID. | AF-08 / Q2 |
| EXT-AF-102 | Дополнено копированием auth/state/work/.git и silent skip existing release. Reviewed runtime deps удалять нельзя. | AF-08,24 / Q2,Q5 |
| EXT-AF-103 | Покрыто; app-generated JSON без доверенной provenance тоже не доказательство. | AF-24,29 / Q5 |
| EXT-AF-104 | Частично: отсутствующий owner/session/effect review принят; TTY/sudo ticket не являются human-presence security boundary. | AF-02,07 / Q1–Q2 |
| EXT-AF-105 | Покрыто; добавлен FACTORY_SERVICE_DB_PATH. Удалять production bypass, а не полагаться только на grep имён. | AF-07,20 / Q2,Q4 |
| EXT-AF-106 | Дополнено PATH/JSON/payload lifecycle; preverified release-dir разрешён C12. Требование второй подписи и 30 min для любого Node download не следует автоматически. | AF-11,12 / Q2–Q3 |
| EXT-AF-107 | Покрыто, включая WAL/PAUSED/restore gates. Не удалять WAL вне quiesced verified restore protocol. | AF-18–20 / Q4 |
| EXT-AF-108 | Дополнено retention contract и trust backup manifest. Статичная 14-day политика — не чтение config; section пока отсутствует. | AF-19,20,27 / Q1,Q4 |
| EXT-AF-109 | Egress уже покрыт; app stale-lock дополнен и воспроизведён. Безопасный recover не равен автоматическому повтору live. | AF-21,22 / Q4 |
| EXT-AF-110 | Основное покрыто, усилены actual ports/RAM constraints. RAM guard есть; wget/internal network — qualification questions. | AF-26 / Q5 |
| EXT-AF-111 | Новая AF-31: реальные ложные resource assertions. Cleanup проверяет rm exit; Docker-group риск уже имеет explicit gate и описан. | AF-07,10,31 / Q2 |
| EXT-AF-112 | Принято hardening отставание от guide. Backup unit имеет User, root execution не доказан; score не заменяет runtime negative tests. | AF-24 / Q5–Q6 |
| EXT-AF-113 | Основное покрыто. Возраст Actions pin не равен доказанной уязвимости; менять после compatibility/provenance review. | AF-28,29 / Q5–Q6 |
| EXT-AF-114 | Уточнён состав rollback и SSH drop-in precedence. Не включать blanket ufw disable как безопасный универсальный rollback. | AF-09 / Q2 |
| EXT-AF-115 | Приняты archive TOCTOU/inventory и command confinement. Fresh inspect и no-same-owner/permissions уже есть, но не устраняют всё. | AF-08,13,24 / Q2–Q3,Q5 |
| EXT-AF-201 | Полностью покрыто и ранее воспроизведено. | AF-04 / Q1 |
| EXT-AF-202 | Полностью покрыто. | AF-03 / Q1 |
| EXT-AF-203 | Дополнено version/error envelope. `uninstall` не обещан контрактом — не обязательный repair. | AF-27 / Q1 |
| EXT-AF-204 | Дополнен stale cancel, собственным тестом подтверждён release чужого nonce. | AF-06 / Q1 |
| EXT-AF-205 | Дополнено identity fallback/typed overflow/apt env; textual truncation marker уже существует. | AF-04,14 / Q1 |
| EXT-AF-206 | Принята qualification pins/compatibility задача, уже покрытая. Заявления о «latest», уязвимости по возрасту и неверном Node hash не импортированы как факты. | AF-10,11,15,28 / Q2–Q3,Q6 |
| EXT-AF-207 | Покрыто, добавлены конкретные lint gates. | AF-28 / Q6 |
| EXT-AF-208 | Дополнены missing starter files/link check и синхронизация contracts. Копии CONTRACT сейчас одинаковы. | AF-27,28 / Q1,Q6 |
| EXT-AF-209 | Проблема coverage покрыта; «вообще все тесты mocks» отвергнуто как слишком широкое утверждение. | AF-28 / Q6 |
| EXT-AF-210 | Уже покрыто; собственный запуск PoC подтвердил отказ systemd 255, а не успешную root injection. | AF-24 / Q5 |
| EXT-AF-211 | Не обязательный security repair: бинарный fixture в git допустим; перенос в Releases сам по себе не обеспечивает authenticity. Reproducible signed release/provenance уже требуется, публикация отдельно. | AF-11 / Q3; optional repo hygiene |
| EXT-AF-212 | Пробел поддерживаемого private-repo credential interface подтверждён кодом; реальный private fetch NOT RUN, не объявлять невозможным при любой внешней настройке. | AF-29 / Q5 |
| EXT-AF-213 | Полностью покрыто: S07 global container name/ownership. | AF-23 / Q3 |

Сопоставление приоритетов: внешний P0 включает функциональные blockers, наш P0 — прежде всего опасные trust/recovery failures. Поэтому разница P0/P1 между отчётами не означает, что несовместимость M0 разрешено отложить: она остаётся обязательным blocker в Q3. Сохраняется последовательность Q1→Q6; правило внешнего отчёта «одна находка = один PR» не обязательно для взаимосвязанных core изменений.

## Дополнительные доказательства редакции 2

```text
Runtime: Node v24.19.0, npm 11.9.0; local systemd-analyze 255
S04_BAD_LIMITS: cpu=0, memory=1099511627776, pids=999999,
  cgroupApplied=true, cleanupOk=true, stageApplyReturned=1
  inspectCalls=1 (before rm only); runHasNetworkNone=false
SERVICE_COPY: recorded sudo argv = /usr/bin/cp -a <whole app> <release>
SERVICE_EXISTING_TARGET_COMMANDS: 0
CANCEL_UNBOUND_CONSUMED: true
LOCK_OTHER_NONCE_REMOVED: true
RUNNER_STALE_LOCK: exit=1, Error: active.lock exists
RUNNER_STATUS_INVALID_POLICY (policy={}): exit=0
WRONG_FLAG_EXIT: 0; package installed; expected SRI not enforced
  npm warn Unknown cli config "--integrity"
WRONG_LOCK_EXIT: 1; EINTEGRITY (fresh cache control)
systemd-analyze verify supplied evil2.service: exit=1
  Unbalanced quoting; Unit configuration has fatal error; unit will not be started
```

Методика: S04 — настоящий adapter и validator, fake process responses/fixture host observation; service — только запись argv fake process, **sudo/cp не запускались**. Locks/runner — временные каталоги, runner run остановился до Docker, status работал с PATH без Docker. npm — собственный local tarball без dependencies и scripts, `--offline --ignore-scripts --no-audit --no-fund`, затем тот же tarball с неправильным lock integrity и новым cache. Systemd — только статический verify приложенного unit, без установки/запуска service. Остальные исходные PoC прочитаны; дублирующие уже подтверждённые сценарии повторно не запускались. Полные test suites не перезапускались: исходники проекта не менялись; числа 81/23 относятся к первому проходу аудита.

Дополнительные primary sources: [Docker: группа docker даёт root-level privileges](https://docs.docker.com/engine/install/linux-postinstall/), [npm: integrity в package-lock](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/), [systemd service command semantics](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html). Последняя online-страница относится к новой версии systemd; результат отказа newline PoC получен локально именно на 255.

Не добавлены в обязательный scope: новый uninstall, переписывание git history ради tarball, автоматическая публикация assets, произвольное обновление всех pins на latest, обязательный rootless redesign. Не приняты как доказательства: `status` как policy validation, TTY как защита от same UID, Running как cgroup enforcement, самописный JSON как независимый security attestation.
