# Задание Copilot: Q1A-R2.2.1 — финальный допуск и достоверность evidence

Выполни **только R2.2.1** по `reviews/R22-audit.md`. Исправь R221-F01 и R221-F02, сохрани подтверждённые результаты C13/S03 и проведи ограниченную диагностику R211-O02. Результат — локальные изменения, регрессионные доказательства, отчёт и воспроизводимый пакет. Не начинай R3, Q1B/Q2–Q6 или разработку приложения фабрики.

**НЕ делай коммиты. НЕ пушь. НЕ создавай ветки, worktree или PR. НЕ выполняй merge/tag/release/deploy. НЕ используй staging/index для упаковки, включая `git add -N`. Все изменения должны остаться локально. Сохраняй эти запреты во всех следующих генерируемых промптах для ИИ-агентов.** Публикация владельцем — отдельное действие.

Не запускай реальные sudo/APT/systemd/SSH/UFW/Docker-daemon, credentials/OAuth/model/provider calls, provisioning или deployment. Допустимы owned temp filesystem, injected external adapters и безопасные локальные дочерние процессы. Не ослабляй проверки, чтобы пройти на неподдерживаемом хосте или под root: используй явные test identities, укажи actual UID отдельно.

## 1. Зафиксируй исходную точку

Проверенный master: `ad84212831892d18ab4dbcaab0d1bfecdc103f1b`, tree `5ceab7c5de2838555f7a3eae12bd01f6c4635832`. Его actual base: `f12791cf8416fc115d45246f0531ce103fa5e2e8`; setup совпадает с ранее проверенным `117a71e`.

Входной пакет Copilot R2.2: `audit/evidence/q1a-r2-2-2026-10-26-local/`; SHA256 ZIP `bcc9f3a25ae693d4922ed39d5e81755178d20874dfd6d7341fbcbb30941a030e`. Новый reviewer пакет — `R22-evidence.zip`, контрольная сумма рядом. Распакуй его безопасно в отдельный локальный каталог. В нём `evidence/` содержит runners, raw outputs, oracles и проверку identities.

Прочитай AGENTS.md, текущие контракт/документацию, `setup/docs/plan-context-r22.md`, этот аудит и предыдущий R2.2 task. Не выдавай устаревшую пометку design-only за описание фактически существующего кода.

До изменений зафиксируй HEAD/tree, branch, status, hash index и всех relevant tracked/untracked inputs. Существующие изменения владельца не сбрасывать, не stash/clean/reset, не подменять их своей baseline. Если HEAD отличается, явно сопоставь delta с проверенным commit. Для baseline/reconstruction допустима обычная directory copy или `git archive`, без checkout/веток/worktree/index.

## 2. Подтверди meaningful red до исправления

Reviewer независимо получил typecheck PASS, 485/485 setup tests, context5/5, original S03 13/13, genuine v1→C13 13/13 и v2→C13 13/13. **Сохранить эти результаты.** Полный independent comparison остаётся INCOMPLETE; исходный final-recovery oracle остаётся red с доказанным fresh-review workaround.

Новые файлы в reviewer ZIP:

- `evidence/context-boundary-probes.cjs`: 10 случаев, actual engine/S02, реальные temp files, fake APT/identity.
- `evidence/release-boundary-probes.cjs`: 4 случая, actual engine/S05 и actual archive hash, fake release effects.
- `evidence/check-boundary-results.py`: проверяет IDs, количество строк, META, срабатывание barrier и outcome; отдельно desired и observed-current.
- Соответствующие JSONL, stderr и `boundary-{fixed,observed-current}-oracle.json`.

Запуск после сборки setup: `node <runner.cjs> <absolute-repo-directory>`, stdout/stderr в новые отдельные файлы с указанными checker имёнами. Затем `python3 <check-boundary-results.py> <output-directory> --expect fixed`.

На исходной версии требуется зафиксировать **14 complete cases / 6 desired PASS / 8 desired FAIL**, desired checker exit1; `--expect observed-current` exit0 означает только воспроизведение дефектов. Сам process exit0 у runner никогда не равен product PASS. Если fixture не достигла нужной границы, это harness failure, а не безопасный отказ.

Сохрани исходные runners и результаты неизменными. Если после рефакторинга нужен адаптер к новой точке чтения, вынеси его отдельно и объясни mapping. Barrier в исходном S02 выбирается по вызову `policyObservation` внутри второго `admitPlanPolicies`; S05 использует пятый archive hash, stack подтверждает последний context capture перед первым effect. Новая реализация не обязана сохранять эти номера или имена. Адаптация должна сохранить **момент изменения входа относительно последнего длительного read**, настоящий producer/admission, counters и desired zero effects. Нельзя получить green от несработавшего hook.

## 3. R221-F01: согласованный допуск после последнего длительного чтения

Проблема в `engine.ts` около 1307: `assertRequestUnchanged → await assertPlanContext → intent/apply`. Во время второго шага config/plan могут измениться; действие всё равно начинается. В `plan-context.ts` version lock читается раньше archive hash и устаревает во время него.

Исходные факты:

| Сценарий | Сейчас | Требуется после исправления |
|---|---|---|
| S02 config swap во время final context read | exit8, но refresh=1, checkpoint создан | Typed refusal; refresh/simulate/install=0/0/0, без intent |
| S02 plan swap там же | То же | То же |
| S05 lock pin swap во время final archive hash | exit8, но extract=1 | extract/materialize/probes=0, без intent |
| S05 config или plan swap там же | exit8, но extract=1 | То же |
| Fault-off S02 | exit0, 1/1/1 | Сохранить |
| Fault-off S05 | exit0, extract2/materialize1/probes3 | Сохранить смысл; две extraction относятся к двум отдельным staging-операциям |

Требования к реализации:

1. Сформулируй единый проверяемый invariant финального допуска: конкретный producer plan, immutable request bytes, текущий context, policy frontier, TTL и gates согласованы **после всех длительных read-only probes/hashing и до первого intent/effect**.
2. Сконцентрируй общий механизм так, чтобы `apply`, `resume` и `gate approve` не расходились по порядку и набору проверок. Проверь также final publication в `runPlan`: там request check тоже предшествует context capture. Не публикуй успешный current review из уже изменившихся входов.
3. Закрой оба класса окна: изменение config/plan во время context capture и изменение ранее прочитанного lock во время archive hash. Перестановка одной строки либо ещё один полный capture с тем же внутренним порядком не закрывает весь класс.
4. Используй проверенные bounded bytes/identity и финальную проверку их актуальности после дорогих чтений. Документируй, какие данные и file identities связываются, какие снова проверяются, что является точкой допуска. Не вводи бесконечный цикл «хешировать всё до стабильности» и не перечитывай 1 GiB archive без обоснования для каждой мелкой проверки.
5. Не исполняй plan fields как команды, не добавляй bypass flags, env overrides, новый самоподписанный review либо неограниченный trust cache. Exact stage producer comparison, closed actions и state binding сохраняются.
6. На отрицательной границе: typed nonzero exit, **ноль новых target calls, intent/effect/verify/checkpoint для отвергнутой операции**; не записывать ложный applying/verified или approved. Сохрани единственное доказательство ранее завершённых действий. Если требуется отдельная запись invalidation/manual status, обоснуй её и проверь сохранение receipts/checkpoints/review history.
7. При изменении входа после уже подтверждённой предыдущей операции запрещается следующая операция, а предыдущий checkpoint сохраняется. Fresh explicit review продолжает только оставшуюся последовательность — без replay. Уже начатый bounded effect не объявлять «не выполнявшимся».
8. Сохрани fail-closed поведение missing/invalid/symlink/truncated/unsafe inputs и ограничения размера/времени. Отдельно обозначь остаточную OS-level TOCTOU границу: это задание не даёт права объявить решёнными root writes и Q2.

Для исходных config/plan probes newline меняет frozen request bytes, не семантику. Не превращай этот факт в заявление об исполнении чужой команды. Содержательный lock-pin swap обязателен как отдельный counterexample.

## 4. R221-F02: повторная проверка перед записью approval

Проблема в `runGateApprove`: `assertPlanContext → await admitPlanPolicies → approveGate/saveState`. Observation может поменять config/plan/lock, но gate получает approved и exit0.

После исправления контролируемое изменение config, plan, version lock или применимого release input во время policy probes/final hashing должно отвергать **само одобрение**. Нельзя рассчитывать на отказ последующего apply. Проверки должны охватывать также owner/session и TTL, которые могли перестать соответствовать запросу во время probes.

Проверь durable gate status и evidence до/после, нулевые effect counters, сохранение receipts/checkpoints. Исключи возможность сохранения approval из `finally` после ошибки. Неизменный контекст, новый процесс той же session и корректное явное fresh review остаются разрешены.

## 5. Ровно какие тесты нужны

Добавляй тесты на поведение и durable effects, не зеркала количества вызовов helper. Основной путь — настоящий SetupEngine и настоящие S02/S05 producers; fake только внешние эффекты и identity. Критические отрицательные случаи имеют fault-off counterparts, достижение barrier подтверждено.

| ID | Приёмка |
|---|---|
| A221-01 | Полный исходный reviewer red сохранён; фиксированный desired oracle 14/14 либо явно сопоставленный эквивалент без потери сценариев |
| A221-02 | S02 config и plan меняются во время последнего context read: ноль effects/intent, typed refusal |
| A221-03 | S05 lock pin/config/plan меняются во время последнего archive hash: ноль extraction/materialization/probes/intent |
| A221-04 | Gate approve: config/plan/lock и применимый archive/manifest drift во время probes/hash не публикуют approval; positive counterpart работает |
| A221-05 | Финальное создание plan/review не признаёт старые входы текущими после контролируемой подмены; prepared metadata не авторизует effects |
| A221-06 | Fresh apply и resume/new-engine проходят одинаковые правила; gate-free producer не обходит финальный допуск |
| A221-07 | Поздний drift/TTL/session change после ранее подтверждённого эффекта сохраняет его receipt/checkpoint; следующий effect0; fresh review без replay |
| A221-08 | Предыдущие B01–B05=5/5; original S03=13/13; genuine v1/v2→C13 explicit-review=13/13 каждый |
| A221-09 | C13/schema/producer/target/TTL/crash-publication/command-identity assertions сохранены; полный setup suite без removed/skipped assertions ради green |
| A221-10 | Каждая независимая матрица имеет точные IDs, отсутствие duplicates, ожидаемое число строк и end marker/эквивалент; неполная матрица fail-closed |
| A221-11 | R211-O01 исходный final-recovery known-red не подменён; explicit-review workaround по-прежнему без replay |
| A221-12 | Полное восстановление из actual base + owner layer + agent delta; tested input hashes до/после одинаковы; index пользователя не используется |

Покрой реальные async границы чтения, не только initial read→lock. Одного hook на `mkdir(lock)` недостаточно. Сохрани и ранее существовавшие lock-time swap controls. Не требуется гонять настоящий sudo или Docker для этой матрицы.

## 6. R211-O02: ограниченная диагностика неполного replay

Reviewer общий запуск `validate-r22.py` завершился exit1. В первой сохранённой попытке baseline adapter дал0строк, fixed-new-probes —2строки безMETA, stage-compat —2из5; subprocess exit0. `check-results.py` выдал27PASS, следующий aggregate checker отверг неполный frozen-33. Полный checker39 не запускался. Copilot ранее также сохранял неполные прогоны, а tracing менял результат. Причина не доказана.

Сначала сделай пропуск/ранний выход непригодным для любого standalone PASS: общий wrapper/completeness checker должен валидировать **exact case IDs**, уникальность, declared/actual counts, end marker, product predicates и exit/signal. Если frozen исходник не имеет META, добавь внешний completion contract либо прозрачный runner wrapper; оригинал сохрани. Не меняй исходные product assertions ради полноты.

Ограничь диагностику одним исходным прогоном и одной целевой instrumented попыткой на первый incomplete runner. Сохрани обе отдельно, с argv/cwd/env allowlist без секретов, Node/npm/OS/arch/UID, duration, stdout/stderr, кодом/сигналом завершения и последним начатым/законченным шагом. При необходимости фиксируй `exit`/`beforeExit`, незавершённую top-level работу и owned FS/child boundaries. Таймаут увеличивать только по конкретному измерению, не до случайного green.

Если причина найдена, исправь соответствующий harness/runtime integration слой и добавь детерминированный контроль раннего завершения. Повтори затронутый runner и затем полный валидатор один раз на окончательных bytes. Если причина не найдена, так и напиши; не переписывай policy/state/lock на основании догадки и не объявляй tracing исправлением. Все incomplete attempts остаются в пакете. Полные матрицы из разных попыток нельзя склеивать в один «полный успешный run».

Составные counts frozen33/command37/R2checker39 пересекаются; не суммировать. Отдельно укажи законченные локальные функциональные проверки и незавершённую квалификацию воспроизводимости.

## 7. Границы изменения

Сохранить C13 v1, exact producer/closure semantics, stable canonical hashing, ordinary-owner requirement, checked actual version lock/archive, legacy historical-only read, review prepared/committed, original attempt/receipt bindings, known-progress continuation и typed blockers.

Не исправлять R211-O01 автоматическим доверием recovered prepared review. Не превращать старые plans/gates в C13 approvals без fresh explicit review. Не возвращать process-local `lastConfig` как источник истины. Не дописывать S03 sudo/SSH rollback реализацию, process supervisor, OAuth, application M0 или live infrastructure в этот проход. Новые production файлы вводить только с объяснением, почему они нужны финальному допуску; не разносить ещё несколько почти одинаковых функций проверки по разным verbs.

Не обновлять package pins, dependencies, ключи или checksum «заодно». Не помечать весь AF backlog или фабрику production-ready по результатам этой задачи.

## 8. Проверка и локальные артефакты

Минимум на окончательных bytes: Node24; `npm --prefix setup ci --ignore-scripts --no-audit --no-fund`, typecheck, полный test; новые boundary desired checks; перечисленные context/S03/migration/frozen/command/R2 checks с completeness validation. `npm ci` не должен затереть изменения владельца в чужой рабочей копии. Базовые снимки собирай отдельно. Все команды/outputs сохранить с правильной классификацией PASS / expected known-red / FAIL / INCOMPLETE / NOT RUN.

Создай:

1. `docs/audits/remediation-q1a-r2-2-1-YYYY-MM-DD.md`: F01/F02 и A221-01…12; concrete before/after counts, evidence refs; статус O01/O02; actual vs injected environment; остаточные границы.
2. `audit/evidence/q1a-r2-2-1-YYYY-MM-DD-local/`: actual base commit/tree; initial/final status/index hashes; owner-layer и agent delta при наличии; full-local.patch со всеми new files/deletions; полный relevant tested-files.sha256; raw logs, command ledger, исходные и адаптированные runners, completeness/product checkers; portable reconstruction/validation.
3. `evidence.zip`, внешний `evidence.zip.sha256`, внутренний `SHA256SUMS`.

Проверить восстановление всех relevant файлов, а не только edited subset. Не применять new-files payload повторно, если additions уже в full patch. Не включать node_modules/dist/Git metadata/secrets; ZIP не включает себя. Report/patch/manifest внутри и рядом должны совпадать. Не использовать index для создания diff. Не изменять tested source после упаковки; иначе повторить affected validation и hashes.

Index и существующие пользовательские изменения сохранить. Если во время работы обнаружена внешняя смена index/inputs, зафиксировать before/after и происхождение, если известно; не приписывать неизвестное себе или владельцу и не отменять чужие изменения ради одинакового hash.

Финальный ответ: что исправлено, что не закрыто, фактические meaningful results, files/checksums, точный следующий шаг. **Общий статус PARTIAL**, если остаётся нарушенное требование или неполный обязательный replay. Можно отдельно принять функциональные F01/F02, сохранив O02 OPEN; нельзя под этим заголовком заявить полную приёмку R2.2.1 или production. При готовности передать на независимый review и остановиться; R3 требует следующего задания.

**Завершить только с локальными изменениями. Никаких commit/push/веток/worktree/PR/merge/tag/release/deploy/staging.**
