# Промпт для Copilot: системное исправление agent-factory после аудита

Скопируй текст ниже в Copilot. Передай также файл `audit/agent-factory-audit.ru.md` или положи его в `docs/audits/agent-factory-audit-2026-10-22.ru.md`. Аудит относится к commit `7d845248e7fcd089a36afc8b395b38c7226e09e7`. Если текущий HEAD другой, сначала проверь применимость каждого finding к текущему коду.

**Редакция 2:** учтена проверка всех 39 пунктов независимого аудита того же commit. Сохрани исходные AF-ID, добавь AF-31 и используй таблицу сверки в приложенном аудите. Внешняя нумерация `EXT-AF-*` не совпадает с нашей. Выполняй только принятые уточнённые требования; не копируй отвергнутые рекомендации внешнего отчёта.

---

Ты — senior TypeScript/Node.js engineer, security reviewer и инженер надёжности Linux deployment. Твоя задача — исправить реализацию `se-panfilov/agent-factory` по результатам аудита 2026-10-22, сохранив её архитектуру и границы installer/application. Нужен работающий, проверяемый, возобновляемый процесс, а не набор модулей с зелёными mocks.

## 1. Цель и объём разрешённой работы

Исправь все группы AF-01…AF-31 из приложенного аудита. Работай последовательно Q1→Q6, добавляя regression tests в каждом пакете. Это единое задание на remediation, а не следующий одиночный Pxx. Старое ограничение «один Pxx» не означает, что можно оставить найденные cross-cutting дефекты без исправления. Не создавай параллельных заданий, которые меняют одни core файлы.

Разрешены локальные исправления исходников, tests, schemas, docs и release packaging. Не выполняй реальные sudo/apt/systemd/SSH/firewall/Docker daemon/OAuth/model calls/GitHub writes на рабочем host. VM suite подготовь, но запускай только в отдельно явно разрешённой disposable VM с recovery console. Не меняй sudoers, не создавай платные ресурсы, не публикуй release, не merge/deploy. Не коммить credentials или synthetic private signing keys.

Не заканчивай после анализа или плана. Выполни все доступные code-level исправления и безопасные tests. Если внешняя capability действительно отсутствует, реализуй честный typed blocker и тест его правильности; не создавай application orchestrator/M1/M2/M3 вместо installer. Не используй этот пункт как оправдание оставить broken S00–S07 или fake S03.

## 2. Источники истины и входы

Прочитай:

1. Актуальные `AGENTS.md`, `USER MANUAL.md`, README и implementation reports.
2. `docs/automation/CONTRACT.md` и `setup/CONTRACT.md`, особенно C02–C13.
3. Аудит AF-01…AF-31, automation-plan/architecture и application docs/M0 manifests.
4. Реальный код, schemas, lockfiles и bundled artifacts, а не только отчёты Pxx.

Составь `docs/audits/remediation-2026-10-22.md`: текущий HEAD, применимость каждого AF-ID, точные paths, failing-before reproduction, пакет исправления, итоговый test/evidence, оставшиеся NOT RUN. Не удаляй замечание потому, что существующие tests зелёные. При несогласии приложи доказательство на текущем исполняемом пути.

Нормативный CONTRACT C13 имеет приоритет над несовместимой имплементацией. Восстановление соответствия контракту не требует его произвольного переписывания. Если нужна несовместимая смена публичного формата, подготовь ADR с конкретным diff, migration и compatibility tests. Не объявляй новую semantics версией 1.0.0 и не обходи требование owner review на breaking change. Продолжай остальные независимые исправления.

Целевой первый host: Ubuntu 24.04 amd64, Node 24 с реально проверенным exact pin, ordinary owner. ARM/macOS/Windows — только development/fixtures до отдельной qualification. Default — supervised cloud-only read-only toy runner. Service, Hybrid AI, external GitHub integration и hosted platform checks не prerequisites первого offline runner.

## 3. Неприкосновенные security requirements

- CLI от root отказывает до mutations; исключения только отдельная явно описанная bootstrap owner-creation процедура, не весь installer под root.
- Никаких `sudo node`, произвольного shell из JSON, wildcard sudoers, NOPASSWD recommendations/creation, постоянного root broker или auto-yes на gates.
- Privileged operations — минимальный фиксированный reviewed command/target набор; owner видит exact effects. Аутентификация sudo и approval операции — разные проверки.
- Worker не получает Docker socket, GitHub write token, personal home, setup control files; no privileged/host network/public ports. Checker без model credentials.
- Supervised credential exposure допускается только по отдельному scope-bound approval для reviewed toy/public-owned input. Unattended без M2 broker/egress evidence blocked.
- Secrets/device codes не попадают в JSON stdout, history, receipts, logs, diagnostics без специального безопасного flow.
- Нет auto-paid fallback, paid provisioning, auto-merge, auto-release, destructive git reset и overwrite изменённого user config.
- Реальный side effect нельзя подменять marker с success. При отсутствии реализации — explicit blocked, до исправления реализации.
- Тестовые env hooks не должны ослаблять security policy production release.

Модель угроз должна явно различать доверенные owner/installer/control plane и недоверенный Worker. Gate/TTY/nonce/session binding — процедура review и защита от stale input, не защита от произвольного процесса того же UID с доступом к state. `sudo -k && sudo -v` не доказывает human presence. Не запускай непроверенный AI/project code с owner UID, sudo-контекстом или Docker socket. Если нужен adversarial same-UID сценарий, он требует другой технической trust boundary; не объявляй его решённым косметическими checks. Доступ к rootful Docker делает control plane административно доверенным; hardening unit это не отменяет. Existing Docker-group root-equivalent gate сохранить и сделать работоспособным. Rootless — только отдельное квалифицированное решение, не незаявленная смена архитектуры.

## 4. Q1 — единый исполняемый core и строгая admission [AF-01–07, AF-14, AF-27]

### Контекст stages

Передавай validated config, trusted release/lock identity и adapters явно до первого observe. Удали lastConfig как prerequisite предыдущего plan-вызова. Каждый CLI process начинает с persisted inputs; plan/apply/verify/resume должны работать отдельно. Не решай проблему скрытым replanning внутри apply, меняющим одобренные действия.

Observe — реальные read-only probes. Plan — typed operations + конкретные preconditions, без `pending` wildcard. Apply выполняет только validated approved operation set. Verify возвращает явный typed результат required checks; receipt сам по себе не success. Recover обрабатывает interrupted operation, а не вызывает verify как универсальную заглушку.

### Plan/gates

Реализуй contract hashes: installation, host, owner/session, desired config, version-lock CONTENT, input artifact/template/policy hashes, observation preconditions, TTL и full dependency closure. Self-hash не является авторизацией. Перед каждой mutation reobserve/check; любое существенное изменение → stale plan/gates, новый review.

Создавай pending gates в plan. Preserve approved только при полном binding equality, не продлевать TTL. Везде использовать один verifier: apply, restore, update, live smoke, service/migration/inference. Без глобального --yes. Approve expired gate не может вернуть misleading success. S08 live/S14 update доступны только правильными explicit verbs, не через обход selected_stages.

Один injected clock используется в create/list/approve/verify/execute; убрать прямой Date.now из expiry-решений. Owner видит exact operation/resource/diff/risk; interactive review и operation authentication не заменяют postcondition probes.

### State/lock/recovery

State записывается crash-consistent без предварительного удаления primary. Durable generation/previous strategy; fsync file+directory; если current отсутствует при previous/quarantine/inflight — восстановление или blocked, не fresh init. State schema и host identity проверяются при загрузке; revalidation после reboot; config drift корректно приводит к новому желаемому состоянию, а не вечной ошибке старого hash.

Один lock защищает все control-state mutations, включая gate approve, plan, verify receipts, backup/restore/update и model reservations. Считывай state после получения lock. Cancel имеет отдельный atomic канал. Проверяй nonce/boot/pid/start identity и owned live operations перед recovery/release. Не объявляй directory без owner безопасно stale в окне создания.

Cancel адресуется конкретному run/lock nonce с installation/boot identity; существование произвольного cancel-файла не является запросом для нового run. Старый/неполный/чужой request не прерывает новый apply. Release повторно сверяет owner nonce/identity и не удаляет чужой lock.

Intent → side effect → receipt → verify → checkpoint для каждой операции. При failure оставляй interrupted/unknown и настоящее evidence, не обнуляй inflight. Dependency drift инвалидирует dependents. Полный recover должен реально reconcile либо return blocked/8 с конкретной ручной процедурой.

Cancel/SIGINT/SIGTERM наблюдаются во время операции и между ними. Обычные child process groups останавливай bounded TERM→KILL с evidence, apt/dpkg — специальный safe-boundary/reconcile протокол без слепого таймерного убийства. Unknown cleanup имеет exit 8, а не 130/143.

### Process/preflight/CLI

Process API: trusted binary policy, cwd, controlled env, optional stdin/TTY class, stream output cap до accumulation, deadlines, cancellation, process identity и non-ambiguous completion. Не теряй cwd в systemd/app adapters. Не наследуй произвольные git helpers/PATH/credential env в project inspection.

Добавь structured output_limit_exceeded/truncated outcome (существующий текстовый суффикс недостаточен). Для нужных classes явно LC_ALL=C; для apt — noninteractive env и обработка conffile/debconf без ожидания при закрытом stdin, с policy-safe отказом на неразрешённый выбор. При недоступном/некорректном boot_id/machine-id — typed blocker до mutations, не запись unknown-boot-id/общего fallback hash и не ослабление state schema.

Проверяй точные ID/VERSION_ID ОС, architecture, Node pin, UID/expected user, systemd/cgroup, free RAM/disk/inodes всех целевых mounts и local filesystem semantics. Используй statfs/эквивалент, не directory stat.blocks. S00 receipt сверяется с actual payload/node/hash. Неподдерживаемость не превращается в gate «override».

CLI strict: command-specific args, enum, missing/duplicate values, unknown options/positionals → exit 2. Implement documented update/inference probe verbs. Init supervised default S01–S07, без live; profile service показывает M1/M2 blockers. Не создавать валидную конфигурацию с фиктивными zero hashes. Status без refresh явно recorded/stale; refresh/verify охватывает выбранную установку и сохраняет отрицательные checks.

CLI version извлекай из package/release metadata. Единый top-level catch выдаёт sanitized typed envelope/exit code. Реализуй C13 optional config sections, включая operations.backup_path/retention_days, с finite/positive validation и compatibility strategy; сейчас этих полей нет в schema, а не только в runtime.

### Обязательные tests Q1

- Отдельные subprocesses plan→approve→apply→verify→resume, одинаковый результат при смене cwd.
- Approved→apply не сбрасывает gate; expiry/changed lock bytes/host/resource/session отвергаются.
- Неподдерживаемый host/root/no systemd/нулевые ресурсы никогда verified.
- Crash/ENOSPC на каждой write boundary; current/previous recovery не теряет history/inflight.
- Конкурентные plan/approve/apply/restore/smoke, PID reuse, orphan resources и partial owner.json.
- Cancel на длительном child, output flood, descendants, HTTP timeout/TLS/retry/deadline; no real privileged operation.

## 5. Q2 — настоящие и безопасные privileged adapters [AF-08–10, AF-12, AF-31]

Определи единую elevation strategy для ordinary password sudo и noninteractive отказа. Не проверяй capability через `sudo -n true` и не предлагай NOPASSWD. Предъявляй operation approval отдельно от аутентификации. Поддержи точные documented recovery actions. Не полагайся на переносимость sudo timestamp между разными tty.

Root writes: canonical allowlisted targets, root-owned private staging, no-follow/exclusive safe open, parent/owner checks, проверка одних и тех же bytes при validation/apply, atomic replace+backup. Устрани predictable /tmp files. Не копируй owner-writable release в /opt с сохранением writable ownership; не принимай произвольный unit/ExecStart из редактируемого task/config. Покажи narrow root trust boundary в `setup/docs/privileges.md` с таблицей operation→argv→UID→inputs→targets→gate→recovery.

Проверяй candidate daemon.json ДО замены живого файла; неуспешный restart возвращает проверенное прежнее поколение. Service release materialize только по проверенному inventory: исключить auth/state/work/.git и другие mutable/private данные; сохранить reviewed runtime deps. Существующий target перепроверять по bytes/ownership, не silently skip. User-owned 0700 staging не защищает от adversarial same UID; не позиционируй hash-before-cp как полное устранение TOCTOU. Narrow executor не обязан называться RootRunner; важны фиксированные операции, аргументы, target policy и единый контроль всех privileged effects.

S03 production adapter должен действительно:

1. Обнаружить existing sshd includes/Match/custom port/socket activation и firewall manager.
2. Подготовить reviewed candidate + complete root-owned backups.
3. Проверить candidate syntax/effective config.
4. Установить и реально вооружить rollback timer, проверить systemd state.
5. Требовать независимый private SSH login/owner ack с доступом к recovery console; Tailscale Self.Online недостаточно.
6. Применить staged firewall/SSH cutover с IPv4/IPv6 checks.
7. Снять rollback только после postchecks; failure/reboot восстанавливает реально изменённые файлы/rules. Не подавлять reload errors `|| true` как success.

В rollback включи собственный drop-in, UFW user/user6/before/after и прочее реально изменённое состояние, с root-owned backups. Не делай blanket `ufw disable`, открывающий чужие службы. Cloud-init/include/Match precedence проверяется effective sshd -T, не только переименованием 90-* в 00-*. External/second-session evidence привяжи к текущему host/plan/resource/nonce/TTL; local self-SSH/маркер не равен независимому повторному входу или внешнему port probe.

Реализуй signed apt repo/keyring prerequisite Docker/Tailscale или явно конкретный обязательный manual step с проверкой до продолжения. Pins только из validated lock, не candidate/latest. Busybox/fixtures — digest-pinned. Missing exact pin/invalid metadata/signature/TLS → blocked/security, не downgrade. Apt dry-run не обещает точный прогноз; simulation анализируется на removal/downgrade; existing foreign Docker workloads защищены.

**AF-31, обязательно:** S04 probe сравнивает exact Memory/PidsLimit/NanoCpus, security flags, NetworkMode, image и ownership с запрошенными значениями. Running не означает cgroupApplied. Добавь bounded проверку действующего enforcement на VM и нужное runtime evidence. Offline fixture — network none, если иной режим не обоснован отдельно. `docker rm -f` exit code уже проверяется; дополни cleanup finally и подтверждением отсутствия immutable container ID/labels, различая absent и недоступный daemon. Unknown cleanup → recovery/не verified. Негативный regression: cpu=0, memory=1 TiB, pids=999999, Running=true с правильными labels должен быть отвергнут, хотя текущий code path его принимает.

Bootstrap: release-dir canonical absolute, launcher quoting не исполняет path text, поддержка `.`, spaces и безопасный отказ control chars, lock/recovery, verify installed node actual contents, нет production test bypass. Trust key fingerprint не берётся как авторитет только из того же downloaded bundle.

Установи trusted PATH до первого utility call; проверяй разрешённые binaries и ownership, не только префикс /usr/local. Корректный JSON encoder/контролируемый отказ на control characters. Launcher ссылается на durable installed payload. C12 допускает уже проверенный release-dir: можно использовать обязательный внешний verifier, если bytes/identity не меняются до установки. Не вводи обязательную повторную подпись bash без необходимости и не меняй все download deadlines на 30 min по догадке.

Tests: malicious symlink/hardlink/parent/temp/unit swap; sudo denied/no tty/root/expired auth; signed repo unavailable/wrong key/version; bootstrap cwd/path/concurrency. Настоящие SSH/firewall/rollback — отдельная VM suite, не host tests.

## 6. Q3 — реально работающий упакованный offline MVP [AF-11, AF-13, AF-15, AF-23]

### Setup package

Build/verify roots от import.meta.url. npm --prefix invocation из quickstart работает. Включи runtime dependencies либо bundle. Host deployment setup не выполняет npm install. Bind source_commit к реально упакованным bytes; reject dirty/stale dist либо build из проверенного commit. Не использовать выдуманный commit как достаточное provenance.

Определи signed payload inventory и detached archive envelope без self-hash cycle. Проверяй types/links/duplicates/size/path confinement при archive verification/extraction. Пакет содержит всё необходимое CLI и templates. Если manifest остаётся внешним, он подписан/проверяется и transport/quickstart точно отражают это.

Реальная reproducibility: две сборки в разных temp directories с нормализованными metadata; сравни archive hash. Placeholder keyring допустим только fixture/test candidate, не qualified release. Проверить full versions lock происхождение/использование, а не только shape Node fields.

Qualification evidence генерируй в чистом окружении без локальных usernames/absolute checkout paths; portable относительные references + artifact hashes. Не объявляй pin уязвимым только по возрасту и не подставляй latest: зафиксируй источник bytes/hash, support/advisory review и compatibility pinned CLI/runtime. Непроверенный pin честно NOT VERIFIED.

### M0 contract

Согласуй `runner_run`, `runner_status`, `runner_stop`, `verify_fake` согласно C13, policy (`image`, `timeout_seconds`, `daily_runs` и bounds), outputs и manifest schema. Если нужен adapter — он явно versioned и тестируется на действительном M0 release. Не invent runner_verify как обязательный интерфейс без решения о совместимости.

Реальный M0 archive должен содержать свои dependencies/lock или compiled bundle. Manifest commands confined к reviewed release root и pinned Node; argv корректен с flags перед script. Cwd не случайный. Help/status probes не запускают stop/migration/real worker и не меняют PAUSED. Fake verifier создаёт формально описанный offline result; live adapter не выдает fake результат за live.

Policy acceptance проверяется реальным parse/run path с fake Docker, не `runner.ts status`: сейчас status возвращает 0 даже при policy={}. Для S05 закрепи одну проверенную копию archive bytes на весь inspect/extract; проверяй полный inventory, entry types, links/devices/duplicates/control names/path confinement/size bounds. Fresh observe уже есть, но не устраняет swap после hash. --no-same-owner/--no-same-permissions уже есть и сохраняются. Structured parser предпочтительнее разбора human tar listings. Host probe только reviewed capability после code-trust gate; arbitrary absolute /bin/sh и traversal script args не становятся trusted от факта абсолютного пути.

### Images/runtime

Явно выбери OCI immutable pull или reviewed local recipe. Full base repository@platform digest; не смешивай image ID и RepoDigest. Проверь Codex package SRI по bytes/locked install и presence native executable. Согласуй ENTRYPOINT с actual runner command/timeout и auth command. Не требуй remote RepoDigest от local-only build. S06 сохраняет local image ID привязанный к host/recipe и image existence rechecked.

Удали `npm install --integrity=...` как фиктивную проверку: npm 11.9.0 принимает неверный flag с exit 0. Expected SRI должен проверяться locked install либо вручную по bytes; dependency graph тоже фиксируется. Negative test с испорченным expected digest обязан падать до установки (контрольный npm ci даёт EINTEGRITY). Образ содержит рабочий Node/npm/native CLI и обеспечивает согласованный non-root runtime UID/GID. Не навязывай UID 10001 без bind-mount ownership модели.

Toy fixture второй запуск не меняет HEAD, не перезаписывает чужие файлы; никаких unconditional --allow-empty commits. Ownership containers едино: installation UUID + operation UUID + role; не fixed global names. Stop/cleanup проверяет actual labels/IDs, не broad prefix.

Tests: actual setup+M0 tarballs в пустой среде без parent node_modules; разные cwd; S05–S07 через real stages with fake external calls; isolated CLI --version/init; real Docker offline in VM; two installations; unchanged fixture SHA на втором запуске.

## 7. Q4 — auth/live, secrets и безопасное восстановление [AF-16–22, AF-30]

Auth: отдельный TTY/device flow с working pinned CLI и минимальной сетью, CODEX_HOME/path корректен; stdin не закрыт, code не утекает в JSON/log. Поддержать cancellation/expiry/no tty. Auth directory owner/mode проверяется до mount. Различать наличие credential и проверенную авторизацию; junk directory не authenticated.

Login и runner согласуют effective UID/GID: после login файлы доступны владельцу/runner, не остаются root-owned. Подтверди token refresh с read-only worker auth на pinned CLI; refresh выполняется через owner-controlled flow, без бесконтрольной синхронизации изменённых Worker tokens в host auth.

Live smoke: strict one-operation gates bound к exact reviewed toy/config/release; S07 proof перепроверяется. До отправки атомарно reserve budget/intent. Existing intent/unknown usage блокирует новый вызов до reconciliation; никакого automatic retry. Separate nonce output path; result provider/fixture/run ID/source SHA/terminal status+usage строго сверяются. Конкурентные calls сериализованы. Не повторять реальный запрос после reboot ради проверки.

Restore: только typed dedicated plan, explicit gate, lock, reviewed backup ID/content hash/targets/compatibility. Preflight plan не даёт права restore. Pause/drain/stop до mutations; PAUSED durable до и после. Pre-restore backup, staging и контролируемое переключение поколений; partial failure не оставляет работающую смесь.

Backup/restore paths: строгая schema IDs/entries, absolute/traversal/duplicates/special files/links запрещены. Catch только ожидаемые filesystem errors, не собственные security exceptions. Проверить равенство полного inventory payload и manifest; restore копирует только verified entries. Safe destination parent/leaf opens; retention опирается на actual owned directory, не произвольный backup_id из JSON.

Manifest digest/backup identity привяжи к reviewed restore plan вне mutable payload; hash-файл рядом с данными не доказывает authenticity при подмене обоих. Без произвольного PKI redesign для локальных backups и без обещания защиты от same UID через такой же writable state. Retention использует validated operations.retention_days/backup_path, не только константу 14 дней; последняя действительно проверенная копия сохраняется. FACTORY_SERVICE_DB_PATH не меняет production target: конфиг/capability binding, тесты через DI.

State/DB: один layout для app state/setup live intents/accounting. Не восстанавливать счётчик использованной квоты назад; сохранять unknown requests и reservations независимо от старого backup. SQLite consistent backup через API/app capability; stopped-service WAL-aware restore, integrity/schema compatibility. Restore бинарника/DB/policy согласован. Отдельный service state path поддерживается, auth исключён.

Runner:

- Реальный runtime bound для /out bytes/inodes/files/depth, не только проверка после завершения. Выбери доказуемое bounded storage/export решение и протестируй в Docker.
- Global try/finally cleanup и durable PAUSED/interrupted при fs errors, output flood, SIGINT/SIGTERM, daemon failure. Не удалять evidence неопределённого live результата.

- Отдельно исправь app active.lock: owner-driven recovery проверяет boot/pid/start ticks/nonce и owned resources, quarantines доказанно stale lock. Не путать с installer lock. Не удалять файл только по PID и не автоматически повторять неизвестный live run; unknown usage/reservation и PAUSED сохраняются. `stop` не считается recovery, пока это явно не реализовано и проверено.
- Repo/control/auth/home roots disjoint; reviewed export/worktree exact SHA исключает ignored secrets и чувствительную .git metadata. Trusted git/docker binaries и controlled environment; не выполнять project code на credential-bearing host.
- Supervised exposure gate + scope enforced; unattended M2 mandatory.
- No raw provider/OAuth stream default; allowlisted structured logs, bounded buffers, secret tests across chunks, permissions и retention 14 days/50 MiB по contract без удаления единственного recovery evidence.

Tests: reproduced symlink+unlisted payload restore; traversal backup ID и malicious retention; random interruption points, WAL, unknown model intent, stale output, fake-as-live, secret in ignored .env/.git URL, repo overlap, output disk flood, stream ENOSPC, wrong permissions. Это regression tests обязательных путей, не один фиктивный assert.

## 8. Q5 — расширения без ложной готовности [AF-24–26, AF-29]

Service: typed paused===true и zero active jobs, strict source-bound M1/M2 evidence, effective systemd User/ExecStart/drop-ins/hash, immutable root-owned code и безопасный Node path. Correct systemd escaping, не shell escaping. Foreign/drifted unit не overwrite автоматически. Backup/rollback старого unit, enable state, binary и DB согласован; partial migration не лечить restart без проверки. M1/M2 absent → blocked до любых root mutations.

Приведи service/backup hardening к guide и реальным capabilities: ProtectSystem/ProtectHome/ReadWritePaths, MemoryMax/OOMScoreAdjust, Docker dependency и justified дополнительные restrictions. Не ломай Node path/backup access ради score. Backup unit уже содержит User: не повышай его до root. Unattended executable/payload неизменяемый для service UID. Reject control chars, literal %/$ должны корректно передаваться по правилам systemd; supplied newline PoC пока отвергается systemd 255, root injection не доказана. App --emit-evidence JSON без trusted provenance не решает M2 admission.

Update: implement update plan/apply verbs. Trusted old/new release content/manifests/schema, backup freshness after drain, typed capability argv, operation-bound approvals вместо бессрочных bools. Никакого arbitrary shell/absolute binary из update JSON. Durable phases и recovery после каждого edge. Orphan current symlink — повод перепроверить DB/binary/paused health, не автоматически adopted-success. Rollback запускает verified old release с совместимой DB либо paired restore. При отсутствии application capability — честный blocker.

Inference: исправь df argv; model реально скачивается/проверяется по digest/size, RAM/CPU/disk/inodes проверены; private serving, actual API/model inventory/health, resource profile применяется. Не писать desired digest как observed или health_ok=true по docker ps. Generation probe отдельный explicit gate, no cloud fallback. M3 routing отдельный admission; optional failure сохраняет cloud-only. No shared global volume/container names.

RAM checks уже есть, но low positive min_ram_bytes не должен ослаблять approved model/profile minimum + host reserve при memory10g. 8 GiB для заявленного профиля blocked, точный minimum определить по модели/контракту, не универсальные 12 GiB без основания. Ports проверять структурированным inspect и actual IPv4/IPv6 listeners, включая конкретный non-loopback IP. Проверить healthcheck executable и отдельный download/serving network lifecycle; не выдавать гипотезы wget/internal:true за выполненные тесты.

GitHub/platforms: checkout-only evidence не engineering baseline. Baseline выполняет reviewed checker/test commands либо clearly unsupported/unknown. Строгий trusted collector/import с repository/run_id/attempt/workflow SHA/checkout SHA/artifact digest binding; не доверять произвольному локальному JSON только за слово provenance. Inputs передавать через env и валидировать exact SHA до shell, не inline expressions. Browser adapter отсутствие остаётся blocked. No credentials in target execution.

Зафиксируй supported S09 private-repo flow: explicit public-only/blocked-private до capability либо отдельный reviewed read-only credential adapter. Не наследуй весь HOME/env и не помещай token в URL/.git/config/артефакты/worker. Test public/private/auth-expired/401/403 и отсутствие write полномочий на read-only path. Реальный private fetch выполняется отдельно при предоставленных полномочиях. Actions SHA обновлять по provenance/advisory/support/compatibility review, не лишь ради latest.

Tests: paused=false/not paused, foreign unit/drop-in, partial migration/restart crash, stale backup, changed update payload, unhealthy Ollama running container/no model/wrong digest, malformed GitHub input, checkout-only passing workflow при failing project tests, mismatched evidence.

## 9. Q6 — интеграция, тесты и квалификация [AF-28 + все AF]

Расширь CI на root+setup+M0+release. Минимальные workflow permissions, pinned actions, безопасные fixture keys. Install dependencies в тестовом build без неявных lifecycle surprises. VM не запускается из npm test/обычного CI.

Добавь shellcheck/actionlint и выбранный workflow security lint, rendered-unit verify на systemd 255; security score использовать только вместе с обоснованными exceptions и runtime negative assertions. Link check для README/START-HERE/AGENTS, явная доставка отсутствующих starter instruction/skill файлов или корректировка ссылок, generated/equality check обеих CONTRACT copies; r4 guide archival. Не утверждай «все старые tests fake»: сохраняй полезные real filesystem/process/release tests и закрывай конкретные пробелы.

Подготовь исполняемый owner-authorized disposable VM harness с assertions и машинно читаемыми evidence для:

- два clean install runs и idempotent повтор;
- separate-process plan/approve/apply/verify/resume;
- interruption/reboot/crash в каждой ключевой операции;
- partial dpkg, network/DNS/TLS failure, unavailable pin, low disk/inodes/RAM;
- root/wrong user/no sudo/expired sudo/approval denial;
- SSH/firewall rollback с независимым login и console;
- Docker orphan/foreign workload/resource limits/private ports;
- actual M0 offline artifact path;
- backup verify/restore с WAL и interrupted restore;
- update rollback и emergency cancel;
- optional inference/platform failure без разрушения supervised flow.

Не auto-provision VPS. Harness должен проверять remote disposable marker/host identity и нужную ОС/архитектуру, а не только доверять двум локальным env строкам. Failures действительно инжектируются, postconditions проверяются, outputs/versions/hashes фиксируются. Назови VM tests NOT RUN, если их не запускал. Live OAuth/model test — отдельное решение владельца, один supervised toy call с approval; отсутствие live proof не скрывать.

Пакет release candidate не равен offline-qualified; offline-qualified не равен VM-qualified; VM-qualified не равен unattended-qualified. Readiness статусы должны опираться на evidence конкретной версии/host profile.

## 10. Дополнительная обязательная приёмка по сверке второго аудита

Эти проверки дополняют исходную матрицу, не заменяют её. Каждая строка должна иметь failing-before/passing-after либо честный VM NOT RUN с prepared harness.

| Проверка | Ожидаемый результат после исправления | Пакет |
|---|---|---|
| Единый fake clock, expiry boundary, approve expired | Нет продления/расхождения clock/ложного success | Q1 |
| Cancel от прошлого run; release при другом nonce | Новый run/чужой lock сохранены | Q1 |
| Missing/invalid boot/machine identity, output flood, apt без TTY | Typed safe failure; нет фиктивной identity/бесконечного ожидания | Q1 |
| S04 Running=true, CPU=0, Memory=1 TiB, Pids=999999 | Probe отвергнут; нет verified | Q2 |
| S04 rm failed/unknown/успех с остаточным owned ID | Unknown/residual не выдаётся за cleanup success | Q2 |
| daemon config invalid; SSH rollback изменил drop-in/user rules | Рабочий config не повреждён; exact previous perimeter восстановлен | Q2 |
| Service source с synthetic auth/state/work/.git; изменённая existing target | Секреты/динамические данные не копируются; drift обнаружен | Q2,Q5 |
| Archive swap/extra entry/newline/link; command traversal/absolute shell | Отказ до materialize/probe/root write | Q3 |
| Policy={}; запуск actual parse/run | Ненулевой outcome, даже если status успешен | Q3 |
| Incorrect expected SRI + fresh cache; native CLI/entrypoint | Установка отвергается; реальный runtime conformance проверен отдельно | Q3 |
| Auth UID/GID, modes, read-only token refresh | Runner читает корректный token; refresh не расширяет Worker authority | Q4 |
| App stale lock + orphan/unknown usage; retention/config/env target | Нет скрытого replay; backup targets/retention соответствуют plan | Q4 |
| Systemd %/$/control chars; service writable paths/limits | Exact argv/UID, отказы на запрещённые записи, healthy supported startup | Q5 |
| Low min_ram pin, 8 GiB, concrete public IP bind, missing model/tool | Inference blocked; false health не записан | Q5 |
| Private GitHub unavailable credentials/401/403; artifact secret scan | Явный blocker/правильный read-only adapter, ни одной утечки | Q5 |
| Broken doc link, contract drift, изменённый app/root path | Соответствующий CI gate действительно красный | Q6 |

Не добавляй по внешнему аудиту: uninstall вне контракта, публикацию Releases без разрешения, rewrite git history, безусловный rootless redesign, «human proof» из TTY/sudo, отключение firewall как универсальный rollback. Архив fixture может остаться в git при контролируемом provenance/reproducibility; перемещение в Release assets — отдельное решение, не security fix само по себе.

## 11. Выходные артефакты

1. Исправленный полный рабочий код, без TODO/no-op required behavior и без placeholders/hash fabrication.
2. Regression tests для каждого AF-ID и сквозные separate-process/real-artifact tests.
3. `docs/audits/remediation-2026-10-22.md` с матрицей AF-ID → code → tests → PASS/FAIL/NOT RUN/BLOCKED и объяснением remaining blockers.

   Включи AF-31 и принятые уточнения из таблицы EXT-ID; rejected/unconfirmed утверждения не отмечай как «исправленные уязвимости». Security qualification должна различать source review, fake-external reproduction, VM и live.
4. `setup/docs/privileges.md`: precise sudo trust boundary и recovery.
5. Согласованные schemas/contracts/ADR/migrations, если действительно нужны; никаких тихих incompatible changes.
6. Исправленные quickstart, troubleshooting, qualification и актуальные AGENTS/README/status reports, синхронизированные с кодом.
7. Исполняемая VM qualification suite и runbook для ещё не выполненных real checks.
8. Release packaging/verification, которое работает из пустой среды и связывает artifact с проверенными source/pins/evidence.

Не обязан реализовывать отсутствующие orchestrator/publisher/broker/M1/M2/M3 внутри этого remediation. Обязан обеспечить корректную работу минимального M0 пути и честное fail-closed поведение всех ещё недоступных возможностей. Для optional adapters исправь существующие дефекты, а не просто переименуй их в deferred.

## 12. Финальный критерий приёмки

Мысленно и в доступных tests пройди:

**Clean host:** проверенный setup release → bootstrap → init/config → plan с настоящими inputs → gates → apply → actual M0 package/config/image → offline verification → runner_ready_offline, без model calls и обязательной GitHub/service/inference интеграции.

**Crash halfway:** state не потерян; процесс не повторяет неизвестную mutation/model call; lock/orphans reconciled; пользователь видит точный next action; resume опирается на observed state; cleanup/rollback действительно подтверждён; PAUSED и usage uncertainty сохранены.

**Hostile/incorrect input:** source archive/plan/manifest/backup/config/project path/unit/symlink с нарушением trust boundary отвергается до privileged write или передачи secrets.

Если scenario не проходит, исправь код/tests, а не только текст инструкции. Не обходи gates и не меняй tests так, чтобы они утверждали ложный success.

В конце дай короткий отчёт: исправленные AF-ID, фактические команды/числа tests, не выполненные real checks, remaining blockers и точный допустимый следующий шаг. Отдельно укажи, что безопасно запускать на disposable VM и что ещё нельзя запускать с реальными credentials. Не называй проект production-ready без необходимой evidence.
