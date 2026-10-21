# Архитектура установщика

Решения Фазы1, уверенность 90% до VM qualification. Нормативный интерфейс — [CONTRACT 1.0.0](CONTRACT.md); stage contracts — [plan](automation-plan.md). Этот документ объясняет реализацию без написания установочных скриптов.

## Bootstrap problem и trust chain

| Подход | Плюсы | Ограничение | Решение |
|---|---|---|---|
| Короткая ручная установка Node/nvm | Легко понять и проверить | Shell profile, дополнительные ручные команды, exact pin и systemd PATH | Документированный fallback |
| Minimal Bash bootstrap | Работает до Node; есть в Ubuntu | Shell должен остаться маленьким и проверенным | Основной путь |
| Ubuntu apt nodejs | Подписи/пакетный менеджер | Candidate может не соответствовать выбранному Node24 и type stripping | Не принимать без exact compatibility |
| NodeSource/другой сторонний repo | Удобное обновление | Дополнительный доверенный издатель, не нужен здесь | Не включать |
| Node в Docker для запуска installer | Изоляция части кода | Чтобы поставить Docker, уже нужен installer; host mutations усложняются | Отвергнуть |
| Bundle Node вместе с setup archive | Мало сетевых зависимостей | Большой platform-specific artifact, build/release upkeep | Допустимый offline вариант P15 |

Основной путь: владелец скачивает setup release приватного репозитория на доверенный ПК через обычный GitHub UI, сверяет commit/release checksum из доверенного канала и передаёт по scp. VPS не должен получать GitHub write credentials, чтобы скачать сам installer. `bootstrap.sh`, pinned versions manifest, key fingerprints и release files входят в один reviewed архив. Перед запуском владелец читает bootstrap. Он проверяет Ubuntu/arch/user и минимальные инструменты; при их отсутствии предлагает фиксированную sudo apt команду для ca-certificates/curl/xz-utils/gnupg. Затем загружает официальный Node tarball, проверяет signed SHASUMS доверенными Node release keys и checksum из reviewed lock, распаковывает в private staging, проверяет binary и атомарно устанавливает user-local prefix. Контрольный SHA из того же непроверенного download не удостоверяет издателя; trust anchor — reviewed release/ключи владельца, а не только HTTPS.

Для setup archive первого релиза допускается проверка checksum через аутентифицированную GitHub release page и отдельное owner review commit; это защищает транспорт, но не компрометацию аккаунта издателя. P15 добавляет detached подпись release с owner-held key; private signing key не находится на VPS/в installer. Проверка подписи не разрешает автоматически доверять неизвестному новому signer. Не нужен собственный PKI или auto keyserver trust.

Если bootstrap запущен root, он отказывается до загрузки/исполнения Node. Предварительное создание factory-user — отдельный явный ручной блок quickstart: определить initial account, источник public authorized_keys, создать пользователя, дать sudo, проверить второй login. Нельзя использовать `~` под sudo как выбор source home.

Bootstrap не правит SSH/firewall/Docker, не логинится, не создаёт app repo. Его receipt импортируется core после проверки реальных файлов; он не доказывает готовую установку. На systemd-stage используется абсолютный Node path из observed release. CLI executable хранит ссылку на private exact Node, а не `/usr/bin/env node` с непроверенным PATH.

## Интерфейс и границы модулей

| Интерфейс | Преимущество | Недостаток |
|---|---|---|
| step-01.mjs … | Простая локальная задача | Пользователь сам держит порядок, lock, общие флаги и checkpoint |
| Один монолитный installer | Одна команда | Большая зона изменений и трудно тестируемые side effects |
| Один CLI + stage-модули | Единый state/lock, выбор stage, общий error model | Нужен маленький orchestrating engine |

Выбран третий вариант: обычный TS пакет в `setup/` того же приватного factory repo, отдельный npm workspace при наличии workspaces. Не создавать generic plugin loader или произвольный конфигурационный DSL. Stage registry статический, dependencies явные, external integrations через конкретные adapters. Скрипты пользователя — один bootstrap и один CLI.

```text
setup/
  CONTRACT.md
  package.json
  package-lock.json (либо существующий root workspace lock, один источник)
  versions.lock.json
  bootstrap.sh
  src/cli.ts
  src/core/{config,plan,state,lock,gates,engine,errors}.ts
  src/adapters/{process,filesystem,http,apt,docker,systemd,git}.ts
  src/stages/{preflight,system,access,docker,application,configuration}.ts
  src/stages/{verification,auth,project,service,operations,inference,platforms,update}.ts
  schemas/{config,state,plan,release,application-manifest}.schema.json
  templates/{systemd,ssh,firewall,compose}/
  tests/{unit,integration,fixtures}/
  tests/vm/{README.md,scenarios.md}
  docs/{quickstart,troubleshooting,release,security,operations}.md
  release/ (generated packaging; not state)
```

P00 создаёт shared interfaces/schema skeleton с полной валидацией; P02 реализует engine. Stage PR не меняет произвольно core interfaces. Единственная точка integration — static registry; каждый PR добавляет одну регистрацию после предыдущего merge. Package lock меняется только последовательно. Ни один stage не пишет checkpoint сам. Модули не получают произвольный `sudo shell`: typed operation содержит конкретный program/argv, resources, preconditions, side effects, deadline и gate IDs.

## Desired, observed, recorded

Desired setup.json + lock + application manifest определяет цель. Observed probes измеряют packages/configs/containers/services на этом хосте. Recorded state/events фиксирует попытки и receipts. Сопоставление первых двух определяет действия; history нужен для ownership/recovery. Флаг completed недостаточен. Реальный компонент без checkpoint может быть adopted только после идентификации и проверки, а не потому, что имя похоже.

Критические файлы записываются атомарно; install cache может быть disposable, состояние и backups — durable. Runtime dirs canonicalized; path containment проверяется после realpath родителя, компоненты symlink не следуются для privileged writes. Архив распаковывается с запретом absolute path, `..`, special files, escaping links и oversized expanded content. Config conflict сохраняет прежнее содержимое и `.proposed` рядом в setup diagnostics, не в app source с execution правами.

Plan mode не вызывает apt update, pull, build, login, npm install, systemctl restart или AI. Read-only cache/metadata запросы допускаются и обозначены. Он не обещает точный пакетный dependency resolution, maintainer scripts или сетевую доступность к моменту apply. Перед apply resolve apt simulation и реальные hashes ещё раз; отличающийся план потребует нового gate. Не устанавливать `DEBIAN_FRONTEND=noninteractive` как замену разрешения на destructive conffile choices.

## Привилегии и безопасность

Высокие права кратковременны для approved apt/systemctl/install/sshd/ufw операций. User CLI не становится root. Скопированный root-owned helper допустим только как маленький проверенный фиксированный набор операций без динамического shell или systemctl arbitrary unit input; предпочтительны непосредственные argv sudo-вызовы trusted binaries. Нет blanket sudoers, persist root daemon или Docker socket внутри worker. Docker group остаётся root-equivalent доверенной областью: systemd hardening не изолирует control plane от daemon, если тот скомпрометирован.

Access stage выполняется до OAuth. Правила сети не строятся из issue/prompt. Неизвестный firewall manager/native nftables конфиг не переписывается. SSH cutover: snapshot затронутых файлов/правил, синтаксическая и effective проверка, persisted rollback timer10min, текущая сессия не закрывается, новый независимый login из ПК/телефона, ack exact operation, потом cancel rollback. Перезагрузка до ack: recovery unit оставляет/возвращает старый доступ. Не ставить cloud firewall deny до успешного tailnet и проверки provider console. Rollback не обещает восстановить сетевые ограничения провайдера: это ручная console процедура.

Авторизация — особый канал: CLI показывает device-code напрямую TTY, без capture логов. Устанавливается только выбранный ChatGPT credential; никаких API keys fallback. Secret reference проверяется lstat/owner/mode; каталог не проходит общую archive traversal. Code setup и app не доступны write worker. Live test не вызов AI для решения installer: он проверяет уже установленный продукт, выполняется только по отдельному запросу и не входит в default apply/verify.

## Ошибки и стратегии

| Класс | Обнаружение / этап | Действие | Повтор / предел |
|---|---|---|---|
| OS/arch/virtualization unsupported | os-release, uname, PID1, cgroup feature probe S01/S04 | Abort3/blocked5 | Нужна квалифицированная VM; не эмуляция fallback |
| RAM/disk/inodes недостаточно | MemAvailable/statfs/image-size estimate, перед каждой большой записью | Block3, later pause | Не swap/prune/upgrade tariff автоматически |
| root/no sudo/user mismatch | UID и sudo permission check | Abort3/manual4 | Войти нужным user; не chown весь home |
| Node/Docker wrong version или partial | Executable hash/version + dpkg/daemon | Drift8 | Separate reviewed replacement plan, no latest |
| DNS/network/timeouts | Classified HTTP/process result | Retry GET/download | 3 total/180s; transfer30min с progress |
| TLS/certificate/signature/checksum | TLS verify/gpg/hash | Abort9 quarantine artifact | 0; проверить clock/CA/источник вручную |
| HTTP429/500/503 | Status + Retry-After | Safe transport retry | C10; no blind retry resource creation |
| Registry/version missing |404/apt candidate absent|Blocked5|Новый reviewed lock, без substitution|
| apt update failed/stale indexes |apt result + metadata freshness|Abort6|Не продолжать со случайным старым package candidate|
| apt/dpkg lock | lock-aware apt timeout | Wait120s then manual4 | Не удалять lock; owner checks service |
| Interrupted dpkg |dpkg --audit|Manual4|Owner repairs; resume reobserve|
| Disk fills image pull/build |statfs/daemon error|Abort6, owned temp cleanup|Existing app remains, no global prune|
| Existing config/permissions/path |lstat/hash/canonical path|Drift8/security9|.proposed, owner gate; no overwrite|
| Unknown schema/corrupt state |strict parse/version/hash|Abort2/recovery8|Previous valid snapshot; not ignore file|
| Partial config write |temp/receipt + checksum|Recover8|Quarantine temp, restore known old content|
| Port occupied/service drift |ss/inspect/unit effective config|Blocked8|No kill foreign process|
| Git dirty/wrong branch/origin |status/rev-parse/config|Drift8|New checkout, no reset/clean/stash|
| Private Git no access |read-only remote/auth probe|Manual4|Owner scp archive or dedicated read-only key|
| Remote unavailable/missing commit |fetch result and object check|6/5|GET retries; explicit commit only|
| Docker socket/host mount/public port |container template validation + inspect|Security9 and stop owned container|Reject configuration; no weakening capabilities|
| Secret in diagnostic |synthetic marker tests / allowlist|Abort export; quarantine local output|Rotate real compromised secret owner; never upload logs automatically|
| Agent-modified Dockerfile/script |release hash mismatch/dirty source|Abort9|New reviewed release only|
| Command injection |argv/enum/schema/canonical path|Reject2/9|No shell interpretation|
| Ctrl+C/SIGTERM |signal/cancel request|TERM children, Docker owned cleanup, checkpoint interrupted|130/143 only after confirmed cleanup|
| SIGKILL/reboot |bootID/process identity/inflight intent|Resume observation before writes|No replay AI/external ambiguous request|
| Two installers |atomic installation lock|Exit7|Read-only status allowed; emergency cancel separate|
| Stale checkpoint |actual resource absent or hash differs|Drift8 dependencies invalidated|Reverify and replan, not completed=true|
| Resource exists no checkpoint |ownership labels/hash/receipt|Adopt verified or block8|Never broad prefix cleanup|
| Orphan container |installation/operation labels + app ownership|Stop only owned after inspection|If daemon unavailable exit8, provider console|
| SQLite busy |app migrator busy timeout30s|Manual4|No force kill writer; backup different lock boundary|
| Migration/rollback partially fails |schema/version/integrity|Recovery8 paused|Restore matched DB/app snapshot; never claim rollback complete|
| Installed but smoke fails |offline/live report separately|Failed6, keep diagnostic|No success admission; live needs new gate to repeat|
| Optional inference fails |health/model/OOM/protocol|Optional failed, exit10 if requested|Cloud-only remains; weights retained|
| GitHub timeout after dispatch |operation key + API search|Ambiguous blocked until reconcile|No duplicate dispatch on automatic retry|

## Backup, upgrades и admission

MVP backup архивирует только allowlisted Level1 history/manifests/config, без auth/.env/raw provider dumps; источник самого приложения воспроизводится из reviewed release. Advanced DB backup через app storage API или sqlite `.backup`, integrity и manifest. Retention14d удаляет только owned verified старые копии при наличии хотя бы одной свежей восстановимой; failed backup не запускает retention. Вторая копия pull с ПК, её наличие подтверждается отдельной квитанцией владельца. Таймер локального backup не означает offsite backup.

App update в новом release dir; остановить выдачу, drain, backup, offline test, migrate, atomic current switch, restart paused, verify. Если DB schema несовместима со старым app, symlink rollback запрещён без восстановления backup. Downgrade migrations не обещается. Upgrading installer — другой release path, state copy и schema compatibility до изменения системы. Lost/unknown run budget не обнуляется при обновлении.

## Тестовая стратегия и выпуск

Unit tests не исполняют host commands; fixtures имеют invalid SHA, stale gates, Linux/Windows/macOS env, malformed configs, traversal/symlink, unknown capabilities. Integration tests используют real temp FS и fake command runner для crash boundaries, disk-full write, partial state, failed cleanup, slow child, double lock, clock drift. Отдельно unit тесты pure policy без IO и contract-tests реальных adapters на disposable VM.

VM test runner запускается только отдельной командой после передачи explicit host и disposable marker; никогда из npm test. Не создавать/удалять VPS автоматически. Обязательная матрица C11 плюс SSH второй login, IPv6 exposure, dirty Git, altered Dockerfile, invalid registry signature, auth redaction, SQLite before/after COMMIT, restore old app+DB. Setup qualification без модели возможна; real Codex smoke выполняет владелец после OAuth и отмечает отдельным evidence. Stage missing implementation может возвращать blocked с проверенным reason; это не stub success, и release feature list обязана исключать unsupported path.

Критерий release: все required unit/integration + clean/idempotent/interrupted/reboot/restore VM сценарии прошли на Ubuntu24.04 amd64; установщик не меняет unowned resources; negative security probes действительно получают технический отказ; никакие обязательные TODO/no-op tests не остались; owner review root/network/migrations diff; release lock и manifest полны. ARM64 не рекламируется пока собственная матрица не пройдена. Отчёт включает невыполненные проверки, даты, OS, versions, immutable hashes и результаты.
