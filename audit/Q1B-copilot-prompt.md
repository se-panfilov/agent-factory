# Copilot — Q1B: bounded process supervisor, сигналы и безопасная отмена

Выполни **Q1B** после принятого локального R3.1. Цель — довести запуск и завершение собственных дочерних процессов installer до проверяемого bounded lifecycle, связать его с cancel/SIGINT/SIGTERM и durable state, ограничить output/env. Это реализация installer infrastructure; не разработка приложения фабрики и не production deployment.

**НЕ делай коммиты. НЕ пушь. НЕ создавай ветки, worktree или PR. НЕ выполняй merge/tag/release/deploy. НЕ используй staging/index, включая `git add -N`, для упаковки. Все изменения остаются локально. Сохраняй эти запреты во всех последующих промптах для ИИ-агентов.** Публикация владельцем — отдельное действие.

Не выполнять реальные sudo/APT/dpkg/systemd/SSH/UFW/Docker-daemon/cgroups/VM/VPS/provisioning, OAuth/provider/model/GitHub writes или remote messages. Не использовать credentials. Разрешены owned temporary FS, fake внешние adapters и безопасные собственные локальные child processes с конечным временем жизни. Никаких signals чужим процессам, kill-all, удаления package-manager locks, root brokers или sudoers changes.

## 1. Принятый baseline и неизменные границы

Проверенный commit: **`01d804ffec9848c0e4e57da993971f50488c805e`**, tree `9058f9a04ed09d05102d362edbe8ad3378115df4`. Parent `ad274add0a7ed0a5e0923363ce9e9000bef7c013`. R31-F01…F04 приняты; нового прохода R3.2 не требуется.

Независимый reviewer: Linux x86_64 / Node24.22.1 / npm11.9.0 / actual UID0, injected application UID1000. Exact master:645/645 tests, все прежние589 сохранены, новые56 и прежние74 R3 проверены; один полный inherited run,22 matrices/52 command entries, instrumentation0, no splicing. R31/R3 по14, boundary14/context5, S03/genuine v1/v2 по13, frozen33/command37/R2-checker39. Counts пересекаются.

Материалы задания: `reviews/R31-audit.md`, `R31-evidence.zip`, `R31-checksums.sha256`. Сначала безопасно распакуй evidence отдельно и прочитай README. Поставленный предыдущий пакет также находится в `audit/evidence/q1a-r3-1-2026-10-28-local/`, его ZIP SHA256 `49acb0cb9251853377b7db810da500df24703740ca87d945077ddf42a753261c`. Не выдумывать hashes.

До edits прочитай AGENTS.md, CONTRACT1.0.0 C03/C04/C07/C09/C10/C12/C13, текущие `setup/docs/lock-cancel-r3.md`, `plan-context-r22.md`, `privileges.md`, `operations.md`, предыдущий report R3.1 и этот prompt. Старая запись design-only не описывает фактический код. Не выполнять всю P00–P15 последовательность.

Сохрани HEAD/tree/branch/porcelain, index bytes/SHA256/entries, owner staged/unstaged bytes и relevant tracked/untracked hashes **до правок**. Для read-only Git используй `GIT_OPTIONAL_LOCKS=0`. Не reset/clean/stash/checkout. Snapshot/reconstruction — обычные directories или `git archive`, без worktree/index. Не удалять owner pyc/untracked files. Если HEAD уже другой, отдельно классифицируй product delta и audit-only delta; не менять исходную атрибуцию. Неизвестное происхождение внешних изменений честно указывать.

Сохранить без переписывания:

- Полную lock generation и alive/dead/unknown; protocol mutex, отказ от automatic guard reclaim и resource-aware recovery.
- Strict cancel decoding, atomic publication, retained requests и read-only consumption; stale/foreign/recognised legacy no-op, invalid modern→8, matching→130 только на безопасной границе.
- R221 finite context fence, synchronous TTL/gates и exact receipt/journal/checkpoint bindings. Никаких новых async authorization reads после финального fence перед dispatch.
- Prepared/committed review и no-replay. O01 honest8/fresh-review уже принят; не возвращать auto-approval ради historical oracle.
- R3.1 trusted emergency admission, независимое Docker discovery, ordinary owner, PAUSED publication/outcomes и confirmed prefix. Raw manifest/sudo/shell/foreign ownership запрещены.

Историческая O02 cause остаётся OPEN. Текущий полный run не воспроизвёл симптом; не объявлять причину найденной и не блокировать новую работу требованием восстановить отсутствующие старые bytes.

## 2. Точный объём Q1B

Основные места: `setup/src/adapters/process.ts`, необходимые новые supervisor/policy helpers, `setup/src/cli.ts`, bounded интеграция в engine/StageContext и callers/adapters, emergency deadline, targeted tests/docs. Изменяй callers настолько, насколько нужно для propagation и правильной политики; не ограничивайся unused helper.

Не начинай Q2 privileged executor, настоящие SSH/UFW cutover/timer/rollback, host Docker installation, OAuth/live, app M0/M1/M2, backup/restore/migrations features или service/unattended. Не обновляй зависимости/pins/CONTRACT/public CLI/config/C13 «заодно». Если внутреннему API нужны дополнительные typed options/result fields, введи их явно и обнови actual callers/fixtures. Public JSON остаётся совместимым; используй предусмотренные data/error поля.

Поддерживаемая OS-гарантия в этом проходе — безопасное управление **своей POSIX process group** для допускаемых команд. Не обещать containment malicious child, который делает setsid/daemonizes/escapes, и не считать завершение Docker CLI доказательством остановки daemon workload. Для неподдерживаемого поведения нужен honest refusal/unknown outcome и явная граница; cgroup/root containment не внедрять в Q1B.

## 3. Сначала зафиксируй исходное поведение

Reviewer добавил `q1b-baseline-probes.cjs` и `check-q1b-baseline.py`: пять конечных безопасных Node-child cases, два desired PASS / три FAIL. Пакет содержит raw JSONL/stderr/ledger.

- B01: буквальные argv — positive control.
- B02: limit64, получено79+79 bytes, exit0/outputLimitExceeded=true; child сам ограничен196608 bytes.
- B03: timeout250ms, TERM direct parent, grandchild пишет после deadline; parent/child затем завершаются сами. Это не proof поведения после полного10s KILL.
- B04: явный internal env NODE_OPTIONS исполняет harmless preload. Это не доказанный public config exploit.
- B05: ambient env не наследуется и PATH override уже фильтруется — positive control.

На baseline сначала build, затем collector и оба oracle. Сохрани complete IDs/META, stdout/stderr, exit/signal/duration, actual Node/npm/UID. Baseline oracle0 подтверждает дефекты; desired oracle1 — ожидаемый red. Collector0 сам по себе не PASS.

После изменения internal API сохрани оригинальные scripts и raw. Если нужен новый mandatory execution profile/cancellation token, делай отдельный mapped runner с минимальным wiring diff. Сценарии, реальные children, finite safety bounds и смысл assertions не меняются. Не считать security refusal всех positive commands успехом. Новые oracle должны отличать безопасный typed refusal опасного env от успешного normal execution.

## 4. Process lifecycle и ownership

1. Введи явный owner/lifecycle object для каждого запуска: run/operation identity, PID/group identity, spawn state, termination reason, bounded output, timers/listeners и cleanup outcome. Регистрация происходит до того, как cancellation может потерять child. Нельзя адресовать произвольный PID/PGID из config/JSON/cancel request.
2. Для допускаемых POSIX commands создавай отдельную process group. TERM направляется всей доказанно собственной группе; через **10 секунд** после TERM — KILL оставшимся собственным процессам. KILL и ожидание закрытия streams/процессов тоже имеют конечную границу; укажи точные production значения и основания в docs. Не ограничиваться `child.kill()`/`child.killed`.
3. Обрабатывай normal exit, spawn ENOENT/EACCES, runtime child error, signal exit, timeout, output limit, cancellation до/во время spawn, parent exit при живом descendant, pipe-held descendant, TERM ignored, repeated signals и гонки close/error/abort. Один run settles **ровно один раз**. Сохраняй фактический signal отдельно от exitCode; не превращай отсутствие code в выдуманный успешный результат.
4. Удаляй все handlers/timers/escalations после завершения. Поздний таймер не должен убить следующую generation или другую операцию. Проверяй ownership перед signal; unknown/EPERM — не dead. PID reuse моделировать injected deterministic test, не ожиданием настоящего reuse.
5. Cleanup не подтверждается одним parent exit, close одного pipe, successful kill syscall или elapsed timeout. Проверяй поддерживаемую группу/children и I/O. Если полнота недоказуема, возвращай typed unknown cleanup; не зависать бесконечно и не выдавать130/143.
6. Never `kill(0)`, signal общей группе installer/test runner, pkill/killall, process-name cleanup, broad PID scans with mutation. Негативный foreign-group контроль использует второй **собственный** test child и доказывает, что он не получил signal.

Нужна компактная state machine, понятная по коду. Не разносить логику между несколькими не связанными timers/promises и не маскировать unsettled promise keepalive-интервалом. Инъекция clock/timers/process facts для unit tests допустима; реальные безопасные child tests обязательны для поддерживаемой среды.

## 5. Политики операций: особенно apt/dpkg

1. Определи закрытые internal execution policies и сопоставление всех production callers. Read-only/допускаемый interruptible local child и critical mutation не должны попадать под одинаковый blind timeout kill. Policy нельзя выбирать произвольным полем пользовательского JSON.
2. Для apt/dpkg, migrations, SSH/firewall и неизвестного privileged descendant запрещены automatic retries и timer-kill «как обычного runner». Не удалять package-manager locks. Требование C07/C10 — bounded safe boundary и честное interrupted/manual при неизвестном состоянии.
3. Q1B не обязан реализовать реальный privileged supervisor Q2. Если безопасный запуск/наблюдение/cleanup такого класса сейчас не доказаны, допустим **явный typed blocker до запуска** соответствующего реального adapter. Документируй этот blocker. Нельзя запускать опасный процесс, а затем обещать безопасный detach/cleanup; нельзя возвращать no-op success.
4. На fake critical operation докажи: отмена после начала не приводит к kill или replay; новые действия не стартуют; authoritative in-flight/receipt сохраняются; unknown→8, следующий resume требует reconciliation. Это логическая проверка, не qualification настоящего apt.
5. Обнови wrapper return types и decision-making callers: timeout/output-limit/cancellation/cleanup failure не теряются при сужении `{exitCode,stdout,stderr,timedOut}`. Например, S05 probe не может стать verified только потому, что child завершился0 после превышения output limit.

## 6. Bounded output и env

### Output

- Проверяй допустимость finite positive timeout/output bounds до spawn; NaN/Infinity/negative/некорректные types не включают безлимитный режим.
- Ограничивай накопление **во время чтения**. Один явно документированный общий byte budget stdout+stderr; truncation marker включён в этот budget. Нельзя сначала сохранить всё, затем slice. Не переносить безлимитный поток во временный файл.
- Сохраняй UTF-8 границы через bounded decoder; учитывай split multibyte chunks, interleaved streams и trailing partial bytes. Не выдавай corrupted machine output за достоверный JSON/hash/ownership.
- Превышение лимита запускает соответствующую termination policy своевременно; не ждёт большого основного timeout. Для unsafe-to-kill класса результат/дальнейшее поведение подчиняются разделу5.
- Sanitization и synthetic secret tests должны работать при chunk split/truncation. Raw stdout/stderr/env/argv не включать в public errors/events. Не читать реальные auth/secret files ради tests; не заявлять, что regex скрывает любой возможный секрет.

### Env

- Сохрани отсутствие ambient inheritance, фиксированный PATH, shell=false и абсолютный reviewed binary. Закрой явно передаваемые env keys allowlist по C04/C10.
- Документируй действительно нужные proxy/CA/reference paths и fixed runtime values; проверяй формат/размер/конфликты. Unknown keys и execution-policy overrides должны иметь явное безопасное решение до spawn, предпочтительно typed refusal.
- NODE_OPTIONS/NODE_PATH, LD_*/DYLD_*, shell-startup variables, произвольные git config/executable hooks и Docker endpoint/context overrides не допускаются общим passthrough. Не добавлять wildcard `*` или allow-all escape hatch для tests.
- TLS bypass и включение insecure mode запрещены. Не логировать sensitive proxy credentials и полный env. Допустимые documented positive env cases должны работать без доступа к сети.
- Объясни threat model точно: подтверждён explicit internal env gap, а не внешняя remote exploit chain. Production callers и их источники env перечисли в policy matrix.

## 7. CLI signals, normal cancel и durable state

1. Подключи SIGINT/SIGTERM к production lifecycle. Первый signal инициирует cancellation, прекращает admission новых effects и запускает соответствующий cleanup. Повторные signals не создают параллельный cleanup и не обходят evidence/ownership.
2. Normal durable cancel request должен доходить до активного supervisor допустимого interruptible child, сохраняя full-generation matching. Не заменяй disk protocol process-local flag; другой CLI process должен по-прежнему иметь возможность отмены.
3. Поставь cancellation observation до admission fence либо в уже выполняющуюся операцию; не добавляй async reads между финальным R221 fence/TTL/gates и первым эффектом. Signal до intent означает0 effects; signal после подтверждённого receipt не стирает prefix.
4. Result130/143 — только при подтверждённом безопасном cleanup и durable checkpoint/release. При in-flight/unknown process/resource state или failed persistence/release приоритет у8. Не путай `child exit143` с разрешением вернуть installer143.
5. Не освобождай защиту run так, чтобы ещё живые его children могли создавать эффекты параллельно новому apply. При unknown сохрани lock/in-flight/evidence в подходящем состоянии; recovery остаётся resource-aware и не auto-reclaim.
6. CLI должен вывести один полный JSON envelope; progress только в stderr. Убери преждевременное завершение процесса, обрывающее JSON/cleanup, сохрани meaningful OS exit code. SIGKILL не перехватывать: следующий start использует существующий recovery.
7. Tests проходят через production lifecycle в реальном owned child/harness с injected external adapters. Не вводить production env-флаг bypass root/owner/admission ради достижения ветки. Если actual ordinary-owner/PAM environment недоступен — явно NOT RUN; injection и actual UID записывать раздельно.

## 8. Общий deadline emergency

У текущего кода есть20s на каждую команду и до1024 containers, без единого budget. Введи один monotonic deadline на emergency attempt, с конечной отдельно определённой cleanup grace. Выбери и документируй конкретный production budget; не выдавай выбранное число за уже существующее требование CONTRACT. Не продлевай deadline каждым child/retry.

Долгие admission reads и команды используют remaining budget там, где API поддерживает bounded calls. После истечения/отмены никакой поздно завершившийся await не разрешает новый effect. Если текущую операцию/FS outcome нельзя подтвердить, вернуть8 с сохранённым PAUSED/publication state, confirmed prefix и точным unknown remainder; не рисовать общий успех по завершённому prefix.

Проверить исчерпание budget до первого dispatch, между targets и во время команды, включая несколько own+foreign IDs. Не потерять R3.1 not_published/published_unconfirmed/durable и missing-status/service boundaries. Реального Docker daemon здесь нет; Docker ownership/cleanup выполняется fake adapter по прежнему контракту.

## 9. Проверяемая матрица приёмки Q1B

| ID | Обязательный результат |
|---|---|
| B-A01 | Baseline5 complete/2 desired PASS/3 FAIL сохранён; final positive/negative predicates отдельно, без замены original |
| B-A02 | Normal exit/argv/shell=false/absolute binary/CWD controls работают; spawn failure не запускает effects и не оставляет handlers |
| B-A03 | Own parent+child+grandchild; TERM group, TERM ignored→10s→KILL; pipe-held descendant; bounded settle и проверенный cleanup |
| B-A04 | Repeated signals, cancel-before-spawn, error/exit/close race, stale timer/PID generation и foreign owned test group безопасны; settle exactly once |
| B-A05 | Общий output byte cap соблюдается при continuous/interleaved/split-UTF8 output; нет unbounded memory/file accumulation; output failure не становится verified |
| B-A06 | Explicit dangerous env заблокирован; ambient/PATH controls и documented proxy/CA positive cases сохранены; synthetic markers не утекли |
| B-A07 | Все production callers перечислены и используют правильный execution policy/result; critical mutation не получает blind TERM/KILL/retry |
| B-A08 | Реальные owned CLI/harness SIGINT/SIGTERM проходят lifecycle; clean130/143, unknown8; ровно один JSON envelope |
| B-A09 | Cross-process generation-bound normal cancel останавливает дальнейшие эффекты; pre-intent0, confirmed prefix retained, no replay |
| B-A10 | Неподтверждённые children/cleanup/persistence не допускают новый overlapping apply; locks/state/evidence сохраняют правдивый исход |
| B-A11 | Один общий emergency budget, no new dispatch after deadline, PAUSED и confirmed/unknown outcomes сохранены |
| B-A12 | R31 strict cancel/14 probes/56 tests, R3/74 tests/14 probes, R221 boundary14/context5, S03/v1/v2 по13 и O01 preserved |
| B-A13 | Полный suite сохраняет645 исходных сценариев либо каждое обоснованное API assertion mapping видно; frozen/command/R2 complete, counts не суммируются |
| B-A14 | Exact ordered IDs/META/uniqueness/counts/predicates; original failures сохранены; одна полная final attempt, не splicing |
| B-A15 | Tested source/runner hashes до/после и reconstruction совпали; исходный owner layer/index сохранён; dynamic environment report соответствует фактическому run |

Для каждого ID отчёт PASS/PARTIAL/FAIL/INCOMPLETE/NOT RUN с evidence. Pure fake timer tests недостаточны для real-child cleanup; одни sleeps/`child.killed` недостаточны для proof. Используй readiness barriers, реальные exit/stdio/process facts и внешний конечный watchdog только для собственных fixtures. Watchdog termination означает failure/incomplete, а не product cleanup PASS.

Минимальные настоящие child controls должны быть безопасными/конечными и оставлять после себя ноль живых собственных processes. Финальный10s escalation path хотя бы один раз проверить с production defaults; unit clock ускорение не выдавать за этот run. Не отправляй test signals родителю IDE/терминала или общей process group.

## 10. Порядок работы и итоговая валидация

1. Capture/baseline; короткая таблица command→policy→env→timeout/output→cancel/cleanup→caller decision.
2. Supervisor и bounded result/output/env; targeted unit + real owned child cases.
3. Интеграция CLI/engine/callers/critical-operation policy/emergency budget; targeted durable-state negatives и positives.
4. Один полный final run на final bytes: Node24, `npm --prefix setup ci --ignore-scripts --no-audit --no-fund` только в owned snapshot; typecheck; полный suite; Q1B matrices; все inherited обязательные matrices и independent checkers.
5. Seal source/runner inputs, один reconstruction и комплект handoff.

Не повторять полный suite после каждой строки. Исправленный доказанный дефект допускает новый numbered run на новых bytes; предыдущие результаты не стирать. Первый необъяснённый incomplete runner — сохранить raw и одна целевая instrumented диагностика. Не добавлять keepalive, не увеличивать timeout ради green, не подменять incomplete успешным exit и не объединять части разных attempts.

Старый `check-final-r31.py` hardcodes root NOT RUN и count645. Для следующего пакета сделай отдельный текущий checker: фактическая environment metadata и new expected test roster, при этом645 baseline names сохранены. Исторический checker/raw остаётся оригиналом. MAC/Linux ordinary test UID и root-isolated UID0 различать; недоступная среда честно NOT RUN.

Изменения internal API в внешних runners оформлять отдельно и включать **исполняемые** bytes в manifest. Original/mapped/C13 bridge не смешивать. Для genuine v1/v2 первая publication остаётся настоящим old engine; O01/C01 known-red automatic-success expectation не возвращать.

## 11. Документация, локальные артефакты и handoff

Обнови только относящиеся к Q1B docs: process ownership/state machine, policy/limits/env table, cancellation/cleanup outcomes, supported OS boundary, critical blockers, explicit NOT RUN. Не объявляй root-safe filesystem, real sudo/SSH/Docker, malicious-process containment или production полностью закрытыми по local fake tests.

Подготовь пять файлов:

1. `docs/audits/remediation-q1b-<actual-date>.md`: identities/changed files, B-A01…15 matrix, exact commands/results/attempts, принятые R31 invariants, OPEN/NOT RUN и следующий шаг.
2. `audit/evidence/q1b-<actual-date>-local/full-local.patch`: полный воспроизводимый diff от named base; new/binary/deleted files включены, owner layer и agent delta различимы; **без index/staging**.
3. `tested-files.sha256`: все реально использованные source/config/schema/package/test/runner/fixture inputs.
4. `evidence.zip`: original/mapped/new runners, contracts/checkers, raw outputs, exit/signal/duration/cwd/Node/npm/actual/injected UID, safe child cleanup evidence, source checks, reconstruction и README.
5. `evidence.zip.sha256`.

Full patch применить **один раз** к обычному чистому directory snapshot. Split owner/agent patches — альтернативный способ, не дополнение. Не создавать recursive archives старых ZIP, node_modules/dist, repository/git/index или временных deployment trees. Sealing metadata исключать из self-referential payload явно. Не удалять owner files ради чистоты.

Финальный ответ: что реализовано, что подтверждено/не подтверждено, tests и NOT RUN, пути пяти файлов. Владельцу достаточно передать их reviewer. Не просить production VPS, sudo, Docker daemon, credentials, publish или deploy для закрытия этого локального задания.

**Повторно: никаких commits/push/branches/worktree/PR/staging/index/merge/tag/release/deploy. Всё локально; запрет переносится в любые следующие AI-промпты.**
