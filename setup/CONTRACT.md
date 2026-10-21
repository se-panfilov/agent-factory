# FACTORY-SETUP-CONTRACT 1.0.0

Статус: техническая спецификация Фазы 1, не исполняемая программа. Версия контракта 1.0.0 обязательна для P00–P15. Изменения несовместимых интерфейсов — отдельный согласованный ADR и новая major-версия. Исходная архитектура — guide 4 / уточнения 4.1. Все команды ниже — **planned CLI**.

## C01. Границы продукта

Ubuntu 24.04 amd64 — единственная первоначально квалифицированная установка. ARM64 допускается позже только с отдельным lock и VM-отчётом; macOS/Windows — разработка и тесты чистой логики. Один владелец, один VPS, один installer. Никаких Kubernetes, Ansible-like DSL, UI, paid provisioning. Cloud-only supervised — default. Установщик не использует AI для решений; smoke с настоящей моделью — отдельное явное действие после завершения deterministic install, никогда prerequisite offline verification. Установка без credentials обязана дойти до `runner_ready_offline`, а не притвориться успешным live-run.

## C02. CLI и выбор этапов

`factory-setup init --profile supervised|service --config PATH`
`factory-setup preflight --config PATH [--json]`
`factory-setup plan --config PATH [--stage ID] [--json]`
`factory-setup apply --config PATH --plan PATH [--non-interactive]`
`factory-setup status --config PATH [--refresh] [--json]`
`factory-setup resume --config PATH [--non-interactive]`
`factory-setup verify --config PATH [--stage ID] [--json]`
`factory-setup gate list --config PATH`
`factory-setup gate approve --config PATH --id ID --plan-hash HASH`
`factory-setup auth login|status --config PATH`
`factory-setup smoke --config PATH --provider fake|live --fixture toy`
`factory-setup cancel --config PATH [--emergency]`
`factory-setup recover --config PATH [--lock-only]`
`factory-setup backup create|verify --config PATH [--backup-id ID]`
`factory-setup restore --config PATH --backup-id ID --plan PATH`
`factory-setup update plan --config PATH --release PATH`
`factory-setup update apply --config PATH --plan PATH`
`factory-setup inference disable --config PATH`
`factory-setup inference probe --config PATH --checks basic,structured,tools`

`--stage` означает stage и транзитивные prerequisites; plan показывает полный closure. Default apply не запускает live smoke, inference, service, GitHub writes, upgrades. `resume` повторно наблюдает систему и строит план; изменения рисков создают новый gate. `status` без refresh — recorded data с возрастом; refresh/verify выполняют read-only probes с таймаутами, никогда модель. `init` пишет только новый конфиг после проверки родителя; отказывается при существующем файле. `apply` требует явный plan; `--yes` отсутствует. `update` меняет выбранный release, а не весь сервер. JSON stdout — один JSON envelope; progress в stderr. Device codes только в TTY, не в JSON/log.

## C03. Exit codes и итог

| Code | Значение |
|---|---|
| 0 | Все выбранные обязательные действия проверены; optional skipped допустим, не равен verified |
| 2 | Ошибка CLI/config/schema/неподдерживаемая версия контракта |
| 3 | Unsupported host или недостающие права/ресурсы |
| 4 | Требуется ручной gate, re-login или reboot |
| 5 | Blocked: отсутствует application capability, артефакт или обязательное evidence |
| 6 | Операция/verification failed после ограниченных retries |
| 7 | Другой владелец installation lock |
| 8 | Drift, несовместимый state, recovery required |
| 9 | Нарушена проверка подписи/целостности/граница безопасности |
| 10 | Обязательные этапы готовы, но явно выбранный optional завершился failed/blocked |
| 130 | SIGINT или cancel, cleanup подтверждён |
| 143 | SIGTERM, cleanup подтверждён |

Неподтверждённый cleanup имеет приоритет над 130/143: exit 8. SIGKILL не перехватывается; recovery после следующего старта. JSON: schema_version, command, installation_id, desired_hash, plan_hash, overall_status, stages[], manual_actions[], error|null. Ошибка: code, stage, operation_id, retryable, public_message, next_action, evidence_ref; stdout/stderr процесса не вставлять без sanitization.

## C04. Файлы и пути

Desired: `~/.config/agent-factory/setup.json` (0600). History/checkpoints/log: `~/.local/state/agent-factory-setup/` (0700). Cache и release installer: `~/.local/share/agent-factory-setup/releases/<version>/`; launcher `~/.local/bin/factory-setup`. Node: `~/.local/share/agent-factory-setup/node/<exact-version>/bin/node`. CLI вычисляет свою директорию, не зависит от cwd/PATH shell.

Supervised application: `~/work/agent-factory`, включая `state/`, `auth/` и `policy-level1.json`, поскольку A2 использует cwd. Не задавать учебному A2 FACTORY_STATE и ожидать переноса. Factory-toy/checkouts — соседние каталоги вне factory. Service application: `/opt/agent-factory/releases/<commit>/`, `current` symlink; `/var/lib/agent-factory/{state,auth,work}`. Переезд данных — отдельная paused операция, не symlink на personal home. Setup state никогда не смешивается с factory SQLite или `state/PAUSED`.

Конфиг содержит schema_version=1, installation_id UUID, profile, host expected OS/arch/user, paths, release archive/sha256/source_commit, version_lock_path, selected_stages, resource_profile, network policy, secret_refs (только пути), GitHub repository allowlist, optional features. Режим credentials и network исключения задаются явно. Неизвестные поля/enum, относительные data paths, пересекающиеся auth/work/setup paths, symlink из writable project к control directory → отказ. env только документированные proxy/CA, CLI config path и secret-reference paths; секретные значения в args/env не копируются в state. Приоритет: безопасные defaults < config < разрешённые CLI options; policy/security не переопределяются env.

## C05. Release и версии

`versions.lock.json`: schema_version=1, installer contract, exact Node 24.x patch, npm version, exact Docker package set (CE/CLI/containerd/buildx/compose), Tailscale version, exact Codex package, npm integrity, base image platform digest, agent image digest или build recipe hash, optional Ollama image/model full digests, artifact sizes, official source URLs, trusted fingerprints, qualification report refs. Major 24 — архитектурный выбор; guide v24.19.0 — кандидат, не доказанный доступный artifact. P15 обязан разрешить/проверить конкретные pins и выпустить полный lock; null/missing обязательный pin блокирует release. Установка не выбирает latest. Недоступный pin → blocked, не downgrade/upgrade. OS security packages — из подписанного Ubuntu apt snapshot текущей metadata; записать фактические версии и digest metadata. Не обещать битовую воспроизводимость всего apt или image rebuild; неизменяемый готовый OCI artifact даёт более сильное воспроизведение, чем повтор apt в Dockerfile.

Application release включает `deployment-manifest.json`: schema_version, application_version, source_commit, content_hashes, node_range, capabilities[], commands (массивы argv), config/schema versions, migrations range, security_evidence refs. Capabilities — reviewed manifest плюс probes, не строка как доказательство. M0: appendix runner/schema/fixtures packaged отдельно. M1: реальные recover/serve/pause/stop/migrate/status. M2: PR8/9/11 negative tests. Installer не синтезирует эти компоненты.

## C06. Stage API и владение

Stage имеет id, dependencies, supportedProfiles, optional, requiredCapabilities и методы observe(ctx), plan(desired, observed), apply(ctx, approvedPlan), verify(ctx), recover(ctx, interruptedOperation). Результат plan — типизированные операции и risk/gates, не shell strings. Общий engine единственный пишет checkpoint, проверяет зависимости и aggregate status. Stage возвращает evidence/receipts; не редактирует state.json напрямую. Перед apply повторно observe входы и hashes; TOCTOU drift аннулирует plan. Запись operation intent до побочного эффекта, receipt после него, verify затем checkpoint. Resource ID содержит installation_id + operation_id; поиск orphan по label и manifest, не широкому name prefix.

## C07. Состояние и crash

`state.json`: schema_version, contract_version, installer_version, installation_id, host_fingerprint (machine-id hash + OS/arch, без IP-секретов), config_hash, lock_hash, stages[{id,status,observed_at,checks,versions,applied_hashes,artifacts,dependencies_hash}], pending_gates, in_flight_operation, last_error. Status: pending/planned/applying/installed/verified/awaiting_manual/blocked/failed/skipped/interrupted/drifted. installed = операция закончилась; verified = реальные postconditions подтверждены. Boot ID фиксируется в observation, его смена вызывает revalidation, не чужой-host error.

Atomic write: temp в том же FS с mode0600, fsync file, rename, fsync parent; checkpoint previous generation сохранить. JSONL события с sequence и checksum записи; обрыв последней строки → quarantine tail, не весь журнал. Event history — аудит, не источник текущего разрешения запуска. ENOSPC не должен превращаться в completed. Ошибка записи state после mutation → fail safe; следующий observe reconcile по настоящим ресурсам.

Один lock на installation path, атомарное mkdir; owner содержит boot_id, pid, process_start_ticks, nonce, installation_id. PID один недостаточен. Сомнительный/stale lock не удаляется apply. `recover --lock-only` проверяет смерть владельца и live operations, затем quarantines lock; другой boot требует сверки containers. Локальная FS обязательна; NFS/неизвестные lock semantics → blocked. `cancel` использует отдельный atomic cancel request, поэтому доступен пока apply держит lock. Child process group TERM→10 s→KILL, Docker cleanup по labels; apt/dpkg не убивать таймером вслепую: дождаться bounded safe boundary, при неизвестном состоянии оставить interrupted/manual. Нельзя одновременно делать migration и backup/update.

## C08. Recovery/drift

Checkpoint verified + resource absent → drifted, зависимые stages invalidated. Resource present + no receipt → inspect identity/config; совпадает и ownership доказано — adopt после verify; иначе owner gate. Changed user config → `.proposed` + diff, никаких overwrite. Старый plan/gate после hash change недействителен. Более новая state schema → отказ; старая мигрируется отдельно после backup и unit fixtures, без внешних действий. После reboot не повторять живой model run или неизвестный внешне оплачиваемый запрос. Inflight GitHub write сначала GET/reconcile, не retry POST. Restore сохраняет PAUSED и unknown usage; deployment resume никогда не означает application unpause.

## C09. Привилегии/gates

Весь CLI запускается обычным владельцем, root отказ (кроме `bootstrap --prepare-user`, явно отдельной ручной процедуры). Bash bootstrap использует sudo только для минимальных apt dependencies. Root operations — reviewed короткие команды/шаблоны по фиксированному allowlist; никаких `sudo node installer.ts`, общего shell из JSON, sudoers NOPASSWD или долгоживущего root broker. Перед mkdir/chown проверить canonical paths; root write через безопасный временный root-owned файл, не следовать user-controlled symlink. Не принимать произвольный unit/exec из task текста.

Отдельные gates: sudo system changes; Docker group; SSH hardening; firewall cutover; Tailscale login; model OAuth; supervised credential exposure; live AI call; application code trust/build; replace drift; service enable; DB migration/restore; GitHub permissions/write/dispatch; endpoint publication; data delete. Последние два не реализуются default installer. Gate привязан к operation type, host, config/plan hash, ресурсу, expiry 30 минут и owner session. Он не доказывает внешнее действие: после approval необходим probe. Gate нельзя одобрить глобальным --yes. Noninteractive без нужного gate → 4. SSH/firewall cutover только интерактивно с независимым повторным входом и recovery console; не auto-approve в CI.

## C10. Процессы, retries, secrets

spawn argv shell=false, absolute trusted binaries, ограниченный env, stdin для чувствительного ввода, timeout/size bounds. Не исполнять Dockerfile/package script из target repo на host. Installer/app artifacts должны быть доверенно reviewed до npm lifecycle. Worker: no GitHub token/socket/host home/privileged/host network/public ports; checker без AI credentials. Default subscription worker всё ещё читает auth: это принимаемый ручной gate только supervised tiny/public-owned code; unattended требует broker и egress enforcement из app PR8. TLS failure/checksum/signature → 9 без retry/--insecure.

Read-only GET/download: максимум 3 попытки всего, 2 s и 5 s delay, Retry-After не выше 60 s, общий deadline 180 s; DNS/temp network/429/500/503 допускают retry. Большой образ/model transfer — отдельный deadline 30 min, прогресс/отмена, 3 попытки только транспортных чанков, не создания ресурсов. 404 pin/auth/permission → без retry. apt lock ждать до 120 s с сообщением; не удалять lock и не kill dpkg. apt mutation, OAuth, model run, migrations, SSH/firewall — 0 автоматических retries. Docker create ambiguous → inspect unique labels прежде повторного create.

Логи — allowlist событий, не весь env или argv. Scrub известных secret values, Bearer/PEM/token форм; непрозрачный raw provider stream не сохранять default, особенно OAuth device code. Redaction не гарантирует сокрытие любого секрета: не читать auth для диагностики, synthetic markers tests. Каталоги0700, файлы0600, umask077. Optional diagnostic export — sanitization + preview owner. Retention 14 дней, общий cap setup logs 50 MiB; удаляются только own closed logs, не единственное evidence/backup. Строгий permission check перед передачей secret dir.

## C11. Verification и release gate

Unit: decision logic, schema, DAG, hashes, gate binding, drift, retry clock, state migration, process identity. Integration: temp FS, mock runner/HTTP, interrupted writes, ENOSPC, SIGINT, locks, fake apt/docker/systemd/GitHub; no sudo, Docker, AI, paid cloud. VM suite отдельно с owner-provided host, explicit disposable marker и подтверждением; не создавать VPS. Реальные чистая Ubuntu, second run, reboot, dpkg partial, network drop, incorrect versions, missing sudo, disk full, gate denial, optional failure, emergency stop и restore. Два clean runs + failure matrix на каждом поддержанном arch; фактические outputs/versions/hashes в release report. Не выполнено → не PASS. Live Codex один supervised owner-run отдельно; без него статус offline-qualified, не live-qualified.


## C12. Дополнения финальной сверки интерфейсов

Bootstrap CLI: `bash bootstrap.sh --release-dir PATH` (папка уже проверенного release), `--help`; без implicit network trust. `plan` по умолчанию пишет `<setup-state>/plan.json`; `--json` не отменяет сохранение отчёта, `preflight/verify/status` не пишут plan. Backup verify без --backup-id проверяет последнюю verified local копию и пишет её ID; при отсутствии backup exit5, не пустой success.

S12 health проверяет API/model inventory без генерации. `inference probe` запускает ограниченные local-generation проверки только после отдельного gate, не в default apply/verify; ошибка probe не включает облако. S12 API infra probe возможен без app runtime, но registered/routed use требует M3. S11 Level1 backup возможен без S10; связь реализации P11→P10 не делает service обязательным runtime prerequisite. `cancel --emergency` может использовать только подтверждённый app stop adapter/known ownership; отсутствие capability сообщает blocked и точную ручную инструкцию, а не обещает остановку чужих cloud tasks.

В release package CLI имеет собранные dist и runtime dependencies; при deployment setup не обращается к npm. Package lock приложения и его reviewed build/lifecycle проверяются отдельно S05. M0 manifest может описывать команды учебного runner, но не capabilities, которых он не обеспечивает. Generated app image ID хранится локально, не подставляется на другую машину как remote digest.


## C13. Default profiles и точные поля сериализации

Init supervised задаёт selected_stages=[S01,S02,S03,S04,S05,S06,S07]; S00 импортируется только verified bootstrap receipt. S08 доступен через auth/smoke explicit verbs; S09/S11 выбираются отдельно. Init service добавляет S09/S10/S11 и показывает M1/M2 blockers; он никогда не подразумевает auth/live run или unpause. S12/S13 false по умолчанию; S14 запускается только update/restore verb. Если explicit stage dependency уже verified, всё равно observe freshness перед использованием. Stage S10 может развернуть только paused службу без live credentials; queue execution после отдельной application admission.

| Config поле | Тип / правило |
|---|---|
| schema_version | literal1 |
| installation_id | UUID, immutable; init генерирует, clone чужого host требует new installation |
| profile | supervised или service |
| host | object: os=ubuntu, release=24.04, arch=amd64, user=имя непривилегированного owner |
| paths | object: setup_state, app, app_state, auth, work; absolute, nonoverlapping except supervised app/state и app/auth явно разрешены |
| release | object: archive абсолютный local path, sha25664hex, source_commit40hex; загрузка приватного repo optional отдельным adapter |
| version_lock_path | абсолютный local path к reviewed versions.lock.json |
| selected_stages | unique known IDs; defaults выше |
| resource_profile | toy или engine или service; CPU/RAM/disk explicit numbers только через approved config |
| network | object: access=tailscale, docker_backend=iptables, execution=supervised_bridge или restricted; restricted требует app evidence |
| secret_refs | object: codex_auth_dir, optional github_key_file, heartbeat_url_file; пути только, значения не хранить |
| github | object: factory_repository и target_repositories allowlist; первое имя задаёт owner, target default se-panfilov/anarchy-engine |
| optional | object: inference=false, platform_checks=false, external_health=false; true требует отдельных config sections и gates |

Расширенные optional config sections определяет P00 schema по stage fields: inference(image_digest,model_ref,model_digest,download_bytes,memory_bytes,cpu_cores,context_tokens), platforms(allowed_workflows,runner_labels,profile_ids), operations(backup_path,retention_days,health_secret_ref). Все numeric values конечны и положительны; zero budget запрещает запуск, а не снимает лимит. Unknown fields запрещены.

Plan schema: schema_version1, installation_id, host_fingerprint, generated_at, expires_at(30min), desired_hash, version_lock_hash, observations_hash, plan_hash, operations[]. Operation: operation_id, stage_id, kind закрытый enum конкретных adapters, resources[], expected_before_hashes, expected_after, requires_gates[], retry_policy, estimated_effects, unknown_effects[]. Хеш считается по canonical JSON без самого plan_hash; sorting object keys рекурсивно, array order значим. Gate expiry не продлевается resume. Observe timestamp/volatile resource metrics не должны менять desired_hash; меняют пригодность плана при нарушении preconditions.

Application manifest.commands — закрытые capability keys с argv arrays из доверенного release: runner_run, runner_status, runner_stop, verify_fake; для service дополнительно recover, serve, pause, stop_all, migrate, health, backup. Неизвестный command не исполнять; cwd и path confinement привязаны release root, executable Node разрешается из installed pin. Это metadata installer adapter, не новый CLI самого приложения. Команды guide A2 отображаются adapter-ом; отсутствие capability не компенсируется invented command.
