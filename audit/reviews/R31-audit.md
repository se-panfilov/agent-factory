# Agent Factory — независимая приёмка Q1A-R3.1

28 октября 2026, Europe/Amsterdam. Проверен commit **`01d804ffec9848c0e4e57da993971f50488c805e`** (`audit fixes 15`).

**Вердикт: R3.1 принят в согласованном локальном объёме. R31-F01…F04 закрыты. Следующий этап — Q1B.** Новый проход R3.2 по этим четырём замечаниям не требуется. Это принятие installer logic, а не разрешение production deployment и не приёмка самого приложения фабрики.

Подтверждённые факты ниже имеют уверенность **99%** в рамках сохранённых локальных воспроизведений. Вывод о переходе к Q1B — инженерная оценка с уверенностью **95%**. Эти проценты не являются оценкой вероятности безопасности production.

## 1. Что именно проверено

| Объект | Подтверждённый результат |
|---|---|
| Master при получении | `01d804ffec9848c0e4e57da993971f50488c805e` |
| Tree | `9058f9a04ed09d05102d362edbe8ad3378115df4` |
| Parent / named reconstruction base | `ad274add0a7ed0a5e0923363ce9e9000bef7c013` |
| Предыдущий продукт | `e217f397b952942b62e847788dc2e6698ad6d7e5` |
| e217 → ad274 | Setup не менялся; промежуточная публикация относится к audit/input материалам |
| Все пять приложений | Побайтно совпали с файлами опубликованного master |
| Входной evidence.zip | 350 members; безопасные пути/типы, CRC PASS; 349 внутренних SHA256 PASS |
| Tested inputs | 286/286 совпали: 167 source/config/schema/package/test + 119 runner/fixture/reference |
| Reconstruction | Named base + full-local.patch один раз, без index; 286/286 и report совпали |
| Setup diff | 13 файлов, +425/−86: 4 production, 5 test/helper, 4 docs |

SHA256 полученных приложений:

| Файл | SHA256 |
|---|---|
| remediation-q1a-r3-1-2026-10-28.md | `22776ad556e08850c95d4eb92fe76c03fd845a1fd54b17c79e5a7b73d3f1e1f7` |
| full-local.patch | `a1d85e091b90aa42d2b909504ba06bc4c39f5d385868e963f43587fe1336639e` |
| tested-files.sha256 | `62498e889cbf782c9428c6a6c46f7e173ad77d14e4f6002820846a58c6679141` |
| evidence.zip | `49acb0cb9251853377b7db810da500df24703740ca87d945077ddf42a753261c` |
| evidence.zip.sha256 | `d2aa6a1310457c525e1c79a5e5912e51b009139da69217f06a5d7ac4a85044ab` |

Рабочая копия владельца не переключалась. С момента первоначальной полной фиксации до итоговой проверки HEAD, branch, status и index SHA256 совпадают; существующий untracked файл/каталог сохранён. Анализ, сборка и тесты выполнялись в обычных отдельных directory snapshots. Все 286 проверенных inputs сохранили hashes. Production-код reviewer не менял, коммиты/ветки/PR не создавал.

## 2. Независимая валидация

Среда reviewer: Linux x86_64, Node **24.22.1**, npm **11.9.0**, **actual UID 0**, injected application identity **1000/factory**. Среда Copilot: macOS/APFS, actual UID 501. Application identity в fixtures не подменяет реальную FS identity и не доказывает ordinary-owner/PAM host qualification.

| Проверка | Результат reviewer |
|---|---|
| npm ci с ignore-scripts; typecheck | PASS |
| Полный setup suite на exact master | **645/645 PASS**, fail/cancelled/skipped/todo = 0 |
| Сохранение прежних сценариев | Все 589 прежних test names сохранены; новые 56 R31 проверены отдельно |
| Прежние R3 tests | Все 74 сохранены и PASS |
| Исходные независимые R31 probes | **14/14 desired PASS**, collector и oracle не изменены |
| Дополнительные machine-outcome predicates | 14/14 PASS |
| R3 adapted matrix | 14/14 PASS |
| Completeness negative controls | Inherited 13/13; R3 8/8 |
| R221 boundaries / context | 14/14 и 5/5 PASS |
| S03 / genuine v1 / genuine v2 | По 13/13 PASS |
| O01 honest recovery | recover8/repeat8/resume8; fresh explicit review/resume0; no replay |
| Frozen / command / R2 | Mapped frozen33, command37, R2-checker39 PASS; пересечения не суммируются |
| Current cancellation API census | 22 current-source/selected standalone calls с явным ProcessAdapter |
| Весь inherited validation | **Один полный COMPLETE run**, 22 матрицы, 52 ledger entries, instrumentation 0, splicing отсутствует |
| Независимые final checkers | Exact-source/suite и completeness checkers: exit0 |

Suite занял примерно **49.6 s**, весь driver — **128.852 s**. Все ledger exits соответствуют ожиданиям, включая явно сохранённые historical known-red oracles. Это настоящий полный независимый run на неизменном опубликованном коде. Диагностических правок tests/runners для его прохождения не понадобилось.

Для исторических `git archive` driver использовал read-only Git object directory владельца. Его `--repo` указывал на отдельную реконструкцию, `--fixed` — на опубликованный snapshot: hashes проверялись в двух каталогах. Ни checkout, ни index для этого не менялись.

В поставленном `check-final-r31.py` строка `root_isolated_environment: NOT RUN` жёстко записана как характеристика исходного macOS-отчёта. Она закономерно печатается и при повторном запуске reviewer. Это недостаток переносимости текста checker output, не провал root tests. Фактическую среду подтверждают `environment.json`, actual-UID записи и новый ledger. В следующем пакете такую метку нужно вычислять из текущего run, не переписывая исторический output.

У Copilot attempt1 завершился на статической TS2345 в новом тесте, до запуска suite/matrices; attempt2 имеет отдельный полный ledger. Исправление callback `.map(line => JSON.parse(line))` не ослабляет проверку. Причина этой ошибки установлена; она не относится к исторической O02.

## 3. Приёмка четырёх исправлений

### R31-F01 — strict cancellation parser: PASS local

`decodeCancel` теперь отделяет допустимость формата от сравнения generation. Invalid schema2, unknown version, missing/extra/wrong-type owner fields, malformed JSON/UTF-8/duplicate keys и unsafe metadata дают typed8 с сохранением evidence. Только lstat ENOENT означает отсутствие; broken symlink и permission failure больше не становятся no-op. Точный legacy формат распознаётся отдельно и не получает authority. Валидные stale/foreign requests не отменяют другой run; matching даёт130 до следующего эффекта.

Исходные C-v2-missing-field / C-v2-extra-field / C-unknown-version перешли из exit0 с APT1/1/1 в **exit8, effects0/events0**. Controls no request, matching, stale, legacy и broken JSON сохранены. Новые 26 cancellation cases проверяют actual engine/S02, hashes request и state/journal, а не только boolean helper.

Новых await после R221 final fence нет. Декодирование синхронно после bounded control read; full-generation comparison, durable publication и read-only consumption сохранены.

### R31-F02 — независимое Docker discovery: PASS local

Обязанность discovery теперь выводится из поддерживаемого deployment graph: настоящий S05 имеет dependency S04. Поддержанного Docker-free S05 profile/proof нет. Поэтому missing/empty/stale/incomplete/unsafe advisory inventory не отключает фиксированный live query. Это обоснованный выбор для текущего продукта; новое неподдерживаемое исключение no-Docker не придумано.

В исходных E-control / E-no-inventory / E-empty-inventory одинаковые fake live facts теперь дают одинаковый результат: owned container остановлен и проверен, foreign не тронут. Live empty подтверждается отдельным ответом daemon; daemon unavailable, malformed/truncated inspection не становятся доказательством пустоты или чужого владения. Arbitrary labels/IDs из inventory не исполняются; `sudo docker`, install и prune не добавлены.

Это проверка actual adapter logic с fake daemon, а не реальная Docker qualification.

### R31-F03 — structured emergency failure: PASS local

`EmergencyFailure` перехватывает returned и rejected process/FS/admission failures; engine сохраняет typed error и `data.emergency_outcome`. После частичного выполнения остаются PAUSED, attempted/confirmed/unknown, подтверждённый prefix, stopped/skipped IDs и manual-recovery next_action. Automatic fresh-plan retry не предлагается. До admission прежние typed3/5/9 сохраняются.

E-throw-stop и E-throw-after-prefix теперь дают8, не generic6/unexpected_error. Во втором случае confirmed own container не теряется, следующий unknown target не объявляется attempted/stopped.

12 PAUSED publication tests различают отсутствие публикации, rename с неизвестной durability и durable marker; отдельно проверяются старый/новый PAUSED, write/fsync/rename-before/rename-after/parent-sync/post-sync cleanup. Optional observer в `publishControl` синхронный и не меняет порядок записи. Trusted missing-status fixture создаётся **до** S05 publication и действительно достигает `emergency_postcondition_missing`. Отсутствующую app capability не заменяют выдуманной командой.

### R31-F04 — explicit identity: PASS local, включая independent Linux/UID0

`requestCancel` требует ProcessAdapter на уровне TypeScript и отказывает при отсутствии runtime argument. Engine, helpers и current standalone callers передают соответствующий уже используемый adapter. Host-UID fallback удалён. Historical first publications используют прежний API старого engine; mapping сохранён отдельно.

Прежние 15 failures не воспроизвелись: полный исходный suite прошёл на actual UID0 без правок reviewer. Root/foreign production-negative controls остаются. Это закрывает локальную переносимость tests; production запуск CLI под root по-прежнему запрещён.

## 4. Состояние A31 и принятые ограничения

A31-01…A31-14 принимаются в локальном scope. A31-10/11 дополнительно получили независимый Linux/UID0 evidence, которого не было у Copilot. A31-13 не означает установление исторической причины O02.

- R211-O01: ранее принятая честная модель recovery8/fresh review сохранена; prepared metadata не авторизует resume. Original auto-success oracles остаются historical known-red.
- R211-O02: в данном полном run не воспроизведён; **историческая причина неизвестна**. Не объявляю её исправленной из одного успешного запуска и не создаю отдельный бесконечный цикл расследования без нового симптома.
- Protocol guard после crash и resource-bearing/boot ambiguity требуют manual reconciliation. Автоматический reclaim не появился и не требовался R3.1.
- M0 без подтверждаемой status capability остаётся attempted/unconfirmed emergency8; service stop unsupported5. Это заявленные границы, не новые app features в installer ticket.
- Реальные root-safe writes, sudo allowlist, SSH/UFW timer/cutover/rollback и host qualification остаются Q2/qualification.

Код исправлен по существу, а не только под ожидаемые числа. Новые tests включают работающие positive paths. Недостаток читаемости — местами плотные expressions и длинные inline objects; исправлять затрагиваемые участки при дальнейшей работе, без массового форматирующего refactor.

## 5. Следующий этап Q1B: подтверждённый baseline

Следующие пункты относятся к ранее отложенному process supervisor. Они **не переоткрывают R3.1**. Для конкретного ТЗ добавлены пять независимых проверок реального `NodeProcessAdapter` с безопасными собственными Node children; никаких sudo/APT/Docker/network/credentials.

| Case | Что измерено на 01d804f | Desired |
|---|---|---|
| B01-argv-control | Пробелы, кавычки, `--eval` как аргумент и `;` переданы буквально, exit0 | PASS |
| B02-output-budget | При limit64 получено **79 bytes stdout +79 stderr**, exit0, outputLimitExceeded=true. Child output ограничен самим fixture 196608 bytes | FAIL |
| B03-owned-tree-term | Timeout250 ms; TERM непосредственному parent; grandchild выполнил запись после deadline. Return через963 ms, timedOut=true. Оба fixture процесса затем штатно завершились | FAIL |
| B04-explicit-preload-env | Явно переданный `NODE_OPTIONS=--require=<owned hook>` выполнил безопасный preload marker | FAIL |
| B05-ambient-env-control | Ambient canary не наследуется, PATH override отфильтрован, LC_ALL=C | PASS |

Collector exit0 — только завершение пяти cases. Baseline oracle0 подтверждает поведение; desired oracle1 показывает три gaps. Сами scripts/raw/oracles включены в evidence.

### Q1B-F01 — процессная группа, lifecycle и достоверный cleanup

**Высокий приоритет; локальный факт99%, проектное решение95%.** `runCommand` запускает child без отдельной process group и посылает TERM/KILL только прямому child. Собственный grandchild probe доказывает продолжение его работы после timeout. Это не свидетельство выжившего процесса после 10-секундного KILL: fixture специально завершается менее чем за секунду. Статически видно, что escalation также адресует только parent.

Adapter ждёт `close`; inherited stdout/stderr descendants могут задержать его независимо от parent exit. `CommandResult` не сохраняет signal/termination reason/cleanup proof. Output-limit TERM не запускает собственную своевременную KILL escalation; она привязана к общему timeout. CLI не имеет handlers SIGINT/SIGTERM, а normal cancel проверяется на engine boundaries. Нет общего протокола signal → supervisor → durable checkpoint/recovery → один JSON result.

Требуется владение созданной группой, bounded TERM→10s→KILL и финальная проверка, обработка races/error/exit/close, cleanup timers/listeners, инвариант settled-once. 130/143 разрешены только при доказанном безопасном cleanup; unknown →8 с сохранённым in-flight/evidence. Слепой kill apt/dpkg запрещён: отдельная политика критических операций обязательна до реального privileged запуска.

### Q1B-F02 — bounded output во время чтения и учёт результата

**Высокий приоритет; факт99%.** Сейчас каждый chunk добавляется в строки до завершения child, несмотря на превышенный лимит; truncation выполняется в конце. Ограничение итоговой строки не ограничивает накопление памяти. Marker добавляется поверх per-stream лимита, что видно в B02.

Некоторые callers, например S05 command checks в `adapters/git.ts`, проверяют только exitCode/timedOut. Значит, нельзя ограничиться новым флагом, который теряется в wrappers. Нужны общий byte budget stdout+stderr, bounded decoder/redaction, своевременная остановка подходящего класса process и проверка termination/output failure всеми decision-making callers. Реальный OOM не провоцировался.

### Q1B-F03 — закрытая политика env

**Средний приоритет для текущей internal API; факт99%.** Ambient env уже не наследуется, PATH защищён — эти свойства сохранять. Но все явно переданные env keys, кроме PATH, разрешены. B04 подтверждает исполнение owned preload через internal `CommandOptions.env`.

Это **не доказанная удалённая эксплуатация и не найденный public config → NODE_OPTIONS путь**. Нужно закрыть API allowlist по C04/C10 до расширения callers: документированные proxy/CA и необходимые fixed runtime values; запрет Node/loader/shell/git/docker-context overrides. Не ослаблять TLS и не печатать полный env.

### Q1B-F04 — общий deadline и связь с durable cancellation

**Статический факт99%; проектный приоритет высокий.** Emergency имеет20s на отдельную команду и до1024 IDs, но общего budget последовательности нет. Normal cancel/OS signals также не координируются с long-running process на уровне supervisor. Нужен единый lifecycle budget, проверяемый до следующего dispatch, плюс честное сохранение remaining unknown resources. Он должен учитывать cleanup grace и не продлеваться каждой новой командой.

Документация Node отдельно различает `exit` и `close`, указывает, что `killed` не доказывает завершение, и описывает POSIX process groups. Это подтверждает необходимость собственного протокола cleanup, а не использования одного флага child. Источник: [Node 24 child_process](https://r2.nodejs.org/docs/latest-v24.x/api/child_process.html), проверена версия24.22.1. Выводы о конкретном repository основаны на его code/probes, а не только документации Node.

## 6. План до production

| Порядок | Результат этапа |
|---|---|
| Сейчас: Q1B | Управление собственными child processes, ограниченные output/env/deadlines, сигналы и cancel с честным durable outcome |
| Q2 | Узкий privileged executor, реальные безопасные host writes, sudo/APT/S03/SSH/firewall/Docker boundaries и rollback |
| Q3 | Сквозная offline установка/повторный запуск/восстановление на настоящем reviewed M0 release |
| Q4 | Отдельно credentials/live/budget/backup/restore; только явные необходимые capability/profile |
| Optional Q5 | Только выбранные inference/service/platform возможности; не обязательное расширение MVP |
| Q6 | Disposable Ubuntu qualification: clean/idempotent/reboot/failure matrix и фактические evidence |

Application M0/M1/M2 развивается отдельным потоком. Число remediation-итераций заранее неизвестно; один этап может потребовать повторной проверки. **R3.1 не нужно продолжать просто потому, что Q1B ещё открыт.** На ближайший шаг достаточно локальной разработки и безопасных children; VPS и credentials владельца не нужны.

## 7. Действия владельца

1. Передать Copilot `../Q1B-copilot-prompt.md`, этот аудит и `R31-evidence.zip` из общего архива.
2. Разрешить только указанную локальную работу Q1B. В промпте явно запрещены commits/push/branches/worktree/PR/staging/index/merge/tag/release/deploy.
3. Вернуть report, full-local.patch, tested-files.sha256, evidence.zip и evidence.zip.sha256. Публикация владельцем — отдельное решение; для review достаточно пакета.

## 8. Ограничения и самопроверка

NOT RUN: production CLI под настоящим ordinary owner/PAM login; реальные sudo/APT/systemd/SSH/UFW/Docker daemon/cgroups; OAuth/credentials/providers/models; VM/VPS; physical power loss; hostile same-UID/root filesystem adversary; production application/factory qualification.

Принятые локальные tests не доказывают все kernel races, невозможность побега malicious child из группы или корректность реального privileged rollback. Полный Q1B hostile-process containment ещё не реализован. Собственные process probes были конечными и безопасными; после B03 grandchild отсутствовал.

Слабое место evidence — зависимость inherited harness от внутренних API и одного полного текущего run. Поэтому проверены exact IDs, сохранены исходные oracles и отдельно добавлены небольшие real-process probes. O02 не объявляется закрытым без причины. При следующем необъяснённом incomplete run требуется сохранение raw evidence и одна целевая диагностика, а не многократные попытки до green.

Основные исходники привязаны к проверенному commit:

- [lock.ts](https://github.com/se-panfilov/agent-factory/blob/01d804ffec9848c0e4e57da993971f50488c805e/setup/src/core/lock.ts)
- [emergency.ts](https://github.com/se-panfilov/agent-factory/blob/01d804ffec9848c0e4e57da993971f50488c805e/setup/src/operations/emergency.ts)
- [control-files.ts](https://github.com/se-panfilov/agent-factory/blob/01d804ffec9848c0e4e57da993971f50488c805e/setup/src/core/control-files.ts)
- [process.ts](https://github.com/se-panfilov/agent-factory/blob/01d804ffec9848c0e4e57da993971f50488c805e/setup/src/adapters/process.ts)
- [engine.ts](https://github.com/se-panfilov/agent-factory/blob/01d804ffec9848c0e4e57da993971f50488c805e/setup/src/core/engine.ts)
- [CONTRACT1.0.0](https://github.com/se-panfilov/agent-factory/blob/01d804ffec9848c0e4e57da993971f50488c805e/docs/automation/CONTRACT.md)
