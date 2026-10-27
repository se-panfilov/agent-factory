# Задание Copilot: Q1A-R3 — cancel, locks, recovery и emergency

Выполни **один ограниченный remediation-pass Q1A-R3** по `reviews/R221-audit.md`: исправь R3-F01…F04 и определённо обработай R211-O01. Сохрани принятые R2.2.1 final-admission/approval semantics. Результат — локальный код, осмысленные regression tests, фактический отчёт и воспроизводимый evidence package. Не начинай целиком Q1B/Q2–Q6 или разработку приложения фабрики.

**НЕ делай коммиты. НЕ пушь. НЕ создавай ветки, worktree или PR. НЕ выполняй merge, tag, release или deploy. НЕ используй staging/index, включая `git add -N`, для упаковки. Все изменения остаются локально. Повторяй эти запреты во всех следующих генерируемых промптах для ИИ-агентов.** Публикация владельцем — отдельное действие.

Не выполняй реальные sudo/APT/systemd/SSH/UFW/Docker-daemon, OAuth/provider/model calls, не используй реальные credentials, не provision VM/VPS. Допустимы owned temp FS, injected external adapters и безопасные локальные child processes. Не ослабляй owner/OS checks ради теста под root: используй явные test identities и отдельно запиши actual UID. Не отправляй сообщения и не изменяй удалённые сервисы.

## 1. Исходная точка и неизменяемые требования

Проверенный commit: `134ecd884ab77f537f1890b3dd456cc6592090ad`, tree `58a212fa5a30df32437db021f536338507890c47`. Это master с R2.2.1. Parent `564bb057…` содержит предыдущий код ad842 и материалы аудита.

Входы: `reviews/R221-audit.md`, `R221-evidence.zip` с checksum; исходный пакет Copilot доступен в `audit/evidence/q1a-r2-2-1-2026-10-27-local/`. Reviewer ZIP SHA см. `R221-checksums.sha256`, не выдумывай значение. В reviewer ZIP есть `evidence/README.md`, current regression runners, новые R3 probes и raw outputs.

Прочитай AGENTS.md; CONTRACT1.0.0, особенно C03/C07/C09/C11/C12/C13; текущую архитектуру и execution plan; `setup/docs/plan-context-r22.md`, `lifecycle-r14.md`, `access-continuation-r211.md`, `privileges.md`, `operations.md`; этот аудит и код затрагиваемых модулей. Формулировки design-only в старых инструкциях сопоставь с фактическим деревом. Это пользовательское задание на R3, а не разрешение заново выполнять все P00–P15.

До изменений запиши HEAD/tree/branch/status, index SHA256 и hashes всех relevant tracked/untracked inputs. Сохрани owner modifications и их исходное staged/unstaged состояние; не reset/clean/stash/checkout. Baseline и проверку reconstruction делай обычными directory copies либо `git archive`, без веток/worktree/index. Если HEAD отличается, сопоставь delta с проверенным commit. Audit-only разницу явно классифицируй; продуктовый diff не игнорируй. При внешнем изменении HEAD/index во время работы сохрани наблюдения и доступные bytes, не приписывай событие себе или владельцу без доказательства.

Сохрани CONTRACT1.0.0, public CLI/config/C13/state compatibility, закрытые producer actions, exact plan/target identity, approved gate bindings, TTL, обычного владельца, no-replay/checkpoint semantics, review prepared/committed. Не вводи общий `--yes`, автоматическую доверенность recovered plans или новый broad executor. Внутренние типы/локальный формат lock/cancel можно уточнять с явным совместимым либо fail-closed чтением старых артефактов; неизвестный legacy owner не превращается в безопасный stale.

## 2. Сначала воспроизведи baseline, затем исправляй

Reviewer независимо получил **515/515 tests**, boundary14/14, context5/5, original S03 13/13, genuine v1/v2→C13 explicit review по13/13, все frozen/command/R2 comparisons PASS. Один полный replay, без instrumentation и склейки. Сохрани эти инварианты. Количества frozen33/command37/R2checker39 пересекаются; не суммируй их.

Новый runner: `evidence/r3-baseline-probes.cjs`; после сборки setup:

```bash
node /absolute/evidence/r3-baseline-probes.cjs /absolute/baseline-repo
python3 /absolute/evidence/check-r3-probes.py --mode baseline /absolute/baseline.jsonl
python3 /absolute/evidence/check-r3-probes.py --mode desired /absolute/baseline.jsonl
```

Первую команду запускай с раздельным сохранением stdout/stderr в baseline.jsonl и baseline.stderr; фиксируй exit/signal/duration. На 134ecd ожидается **14 complete cases / 7 desired PASS / 7 desired FAIL**, baseline checker0, desired checker1. Этот baseline уже независимо совпал с ad842. Exit0 у collector означает лишь завершение измерений.

Не меняй original runner/raw files. После рефакторинга допустим отдельный adapter runner с явной таблицей old barrier → new barrier. Например, исходный cancel fault бьёт прямой write конечного файла; после atomic publication его надо перенести на действительную temp write/fsync/rename границу, сохранив доказательство уже принятого первого запроса. Original `C-late` использует четвёртое version-lock read; новый hook должен по-прежнему публиковать cancel во время длительного admission **до первого effect**. Новый lock protocol может изменить rename sequence; воспроизведи тот же competing recovery/acquisition порядок на новой точке протокола. Не считать несработавший hook или ранний harness failure безопасным product refusal.

## 3. R3-F01: строгая owner identity и неизвестная liveness

Затронуты `setup/src/core/lock.ts`, минимально необходимая часть `adapters/process.ts`, tests и внутренние типы.

1. Читай owner metadata bounded, валидируй object/schema/fields/types/limits, PID и start ticks, installation/nonce/boot identity. Reject arrays, `{}`, truncated/oversized/unknown-field/unsafe metadata по определённой политике. Проверяй безопасные file type/owner/path; не следуй symlink к чужому control data.
2. Раздели **alive / proven dead / unknown**. `null`/ошибка чтения start ticks, malformed stat, EPERM при signal0, недоступный boot — unknown, не dead. Проверенный start-tick mismatch при живом PID может доказать PID reuse, но не отсутствие оставшихся ресурсов старого run.
3. Исправь proc-stat parser для comm с пробелами/скобками; не используй split всего файла по пробелам. Проверяй числовые границы. Не подменяй реальную identity env-переменной.
4. Собственная lock identity должна быть пригодна для последующей проверки. При неизвестной identity acquisition не должен публиковать usable owner и разрешать effects. Ошибка записи owner после mkdir оставляет диагностируемый незавершённый lock; следующий run не удаляет его автоматически.
5. Разный boot требует resource reconciliation по C07; не считать исчезновение прежнего PID доказательством остановки containers/descendants. Unknown сохраняет evidence и даёт typed recovery/manual action.

Приёмка: L-active/invalid-json остаются отказом; L-unknown-start и L-invalid-shape больше не quarantined; доказанный dead/no-live путь работает. Добавь отдельные EPERM/ESRCH, null/malformed stat, PID reuse и boot-change controls с positive counterparts. Не меняй весь process supervisor в этом задании.

## 4. R3-F02: координация acquire/release/recover

Опиши короткий design invariant до реализации: какая generation lock принадлежит run, какая проверка позволяет takeover, где атомарный переход и какие concurrent participants соблюдают протокол. Реализуй его, а не только повторный `read` перед mutable-path `rename/remove`.

Требования:

1. Сохрани один installation lock и совместимость C07. Согласуй **все** пути acquire/release/recover; новый guard не должен оставлять прежний обходной release. Выбор конкретного локального механизма обоснуй реальными atomic semantics.
2. При interleaving двух recover и последующего acquire первый recover не переносит новую live generation. Release старого handle не удаляет новый lock. Проверка nonce только до await недостаточна.
3. Предварительно проверь installation/owner identity и применимые state/journal/in-flight/resource evidence. `recover --lock-only` не должен сначала освободить путь, а затем сообщить, что отсутствие live operations не доказано. Исторический завершённый журнал сам по себе не равен активной операции; различай resolved/unknown/live.
4. Локальная FS с поддержанными semantics обязательна. Unsupported/unknown semantics и неизвестный ownership → typed blocker с сохранением evidence. Если механизм не может безопасно reclaim свой повреждённый guard, честный manual path лучше автоматического удаления; сохрани нормальный proven-dead positive path.
5. Quarantine имеет уникальную identity, не перезаписывает существующий quarantine; публикация/перенос и ошибки fsync имеют явные crash outcomes. Отдельно тестируй отказ после mkdir, owner write, fsync, до/после rename. Не объявляй physical power-loss qualification по injected error.
6. Lock-only outcome явно означает только результат lock protocol. Не возвращай ложное утверждение об отсутствии state/resource blockers. Если дальнейшая reconciliation обязательна, выдай соответствующий typed non-success/manual action; не сбрасывай in-flight, receipts, gate history или recovery markers.

Нужны deterministic concurrent controls на actual owned FS с управляемыми barriers; при необходимости безопасные локальные child processes. Одного mock, который сразу возвращает желаемый отказ, недостаточно. Не использовать sleeps для вероятностного green. Оставшаяся защита от произвольного hostile OS writer и root FS attacks не становится «решённой Q2» от этих тестов.

## 5. R3-F03: durable cancellation и граница следующей операции

1. Публикуй cancel атомарно: уникальный owned temp, bounded write, fsync(file), atomic publish, fsync(parent), либо доказанный эквивалент. Ошибка повторного запроса не уничтожает ранее принятый matching request. Неполный JSON не виден как опубликованный cancel.
2. Свяжи запрос с installation и полной generation run. Missing/stale/foreign request не отменяет будущий unrelated run. Ordinary owner требуется и для normal cancel по C09; отсутствие installation lock не даёт право писать произвольный путь. Сам cancel остаётся доступен, пока apply держит lock.
3. Consumption/acknowledgement не удаляет запрос другой generation или более новый непрочитанный запрос. Обработай producer/consumer race, concurrent request writers, смену lock во время публикации, повторный matching request и отсутствие активного run. Если линеаризация требует другого внутреннего формата, документируй migration/fail-closed поведение. Не меняй public CLI.
4. Принятый matching cancel проверяется **после длительных admission reads перед новой intent/effect**. В C-late требуется0/0/0 и отсутствие новых S02 events. Сохрани R221 frozen bytes/metadata/TTL/gates fence: добавление await для cancel не должно снова открыть уже закрытое окно подмены context. Спроектируй совместный конечный допуск и протестируй порядок; не просто вставь долгую проверку после последней проверки безопасности.
5. Отмена после checkpoint первой операции сохраняет её exact receipt/checkpoint; следующая не начинается. После явного разрешённого resume нет replay завершённого эффекта. Принятую отмену не стирать так рано, чтобы crash до фиксации результата позволил незаметно продолжить тот же run.
6. Если эффект уже начат, не обещай zero effects. Дождись разрешённой bounded safe boundary; неизвестный результат остаётся interrupted/recovery-required. Нельзя kill dpkg/apt вслепую или автоматически повторять mutation.
7. Exit130/143 только при подтверждённом cleanup; cleanup failed/unknown →8 с evidence. Не скрывай release/cleanup error в `finally` и не превращай его в успешную отмену. Full process-tree TERM/KILL — Q1B; для R3 проверь протокол на injected outcome и безопасном локальном process fixture, если он нужен.

## 6. R3-F04: доверенная emergency stop capability

Затронуты `operations/emergency.ts`, engine entrypoint и узкие общие helpers из S05, если нужны. Не переписывай service/auth/backup целиком.

1. Enforce ordinary-owner root refusal **до PAUSED и command effects**. Normal cancel/recover также не получают исключение из C09. Не требуй обычный installation lock для emergency, иначе он бесполезен при зависшем apply.
2. Допускай только подтверждённый stop adapter доверенного текущего deployment. Raw manifest с одним `commands` не является доказательством. Строгая bounded схема, release/installation/content identity, разрешённые capability keys, checked file metadata и отсутствие drift обязательны. Используй согласованный resolver/identity подход из `adapters/git.ts` и `stages/application.ts`; help/probe receipt сам по себе не заменяет проверку текущих bytes.
3. Нельзя выбирать arbitrary absolute binary, `/usr/bin/sudo`, shell/interpreter eval или traversal argv из JSON. Node — только installed pin, entrypoint и cwd — внутри проверенного release root; symlink escapes и подмена после чтения блокируются. Привилегированные stop operations допустимы только через отдельный известный узкий adapter, если уже существует и доказан; не добавляй общий sudo механизм.
4. Emergency не требует нового обычного plan или fresh gate, когда уже доказана существующая безопасная stop capability/ownership. При отсутствии такого доказательства верни конкретный blocked/manual outcome. Не получать green тотальным запретом emergency: valid trusted supervised stop и genuine foreign-skip positive paths обязательны. Отсутствующий service capability остаётся явно unsupported, не выдумывается.
5. PAUSED должен публиковаться безопасно и durable. Ошибка stop не снимает PAUSED, не объявляет stopped то, что только пытались остановить. Не изменять чужие data paths/installation. Если доверенного безопасного пути к PAUSED нет, не писать туда ради косметического «pause succeeded».
6. Known foreign и unknown Docker ownership — разные результаты. Ошибка/timeout/truncated output/malformed inspect не становятся benign foreign. Inventory IDs/labels проходят закрытую валидацию, не могут выбирать произвольные ресурсы/CLI options. Не полагайся только на недостоверный local inventory.
7. Timeout, output limit, partial stop и неподтверждённый postcondition дают честный nonzero/recovery outcome с перечнем доказанно выполненного. Проверяй доступный stop/status postcondition; missing capability не компенсируется invented command. Реальный Docker не запускай: fake daemon здесь проверяет contract; квалификация host boundary позднее.

Приёмка исходных E-sudo/E-root: nonzero, commands0, без неавторизованного PAUSED. E-missing остаётся blocked. Добавь full trusted-release positive fixture, tamper/traversal/symlink/CWD/Node-pin checks, unknown inspection и failed stop controls. Не называть E-sudo «доказанной root exploitation»: reviewer проверил только unsafe dispatch до adapter.

## 7. R211-O01: честный итог восстановления review

Сейчас оба original final-recovery сценария дают recover0/repeat0/resume8 `context_review_unproven`, затем explicit review/resume0 без повторных effects. Сохрани original raw oracle как historical known-red; не редактируй его expectations задним числом.

Выбери поведение по доказательствам:

- Если exact **committed** review и его связь с восстановленным состоянием действительно доказуемы, восстанови эту связь, повторно проверь актуальный context/policy/TTL/session и только тогда разреши предусмотренное контрактом продолжение. Prepared metadata никогда не авторизует эффект.
- Если committed proof утрачен, результат recovery должен прямо и машинно читаемо требовать **fresh explicit plan/review/approval**. Используй существующий exit8/manual-action contract; различай восстановление bytes и готовность к resume. Повторный recover не превращает неизвестность в успех.

Базовая безопасная цель этого задания — второй путь при отсутствии proof. Не создавай review автоматически, не продлевай gates и не исполняй уже завершённый S03 cutover. Добавь отдельный acceptance oracle для честного outcome и explicit-review no-replay. Документированное уточнение результата не означает, что original auto-resume oracle стал PASS; явно пометь его superseded contract expectation только с обоснованием по неизменному контракту, а его raw red сохрани. Если обнаружен настоящий конфликт с CONTRACT1.0.0, останови только конфликтующее изменение и опиши точный конфликт, продолжив независимые исправления в разрешённом scope.

## 8. Обязательная матрица приёмки

На каждом negative case нужны product code/envelope, точное состояние файлов/evidence до/после, counters, ownership/generation identity и подтверждение, что barrier сработал. На positive counterpart — требуемая полезная операция, а не тотальный fail-closed.

| ID | Условие приёмки |
|---|---|
| A3-01 | Все14 original R3 baseline cases complete; исходные7 desired failures сохранены как baseline |
| A3-02 | Валидный active lock сохраняется; proven-dead/no-live безопасно quarantined; invalid JSON/object/oversize/metadata не дают takeover |
| A3-03 | EPERM/null/malformed identity = unknown; verified ESRCH/PID-reuse корректно различаются; comm spaces/parentheses парсятся |
| A3-04 | Competing recover/acquire не забирает новую live generation; release старого handle её не удаляет |
| A3-05 | Crash/failure publication/quarantine не теряет evidence; unknown FS/live resources/boot reconciliation блокируют до takeover |
| A3-06 | Повторный cancel с ENOSPC/write/fsync/rename fault не уничтожает принятый запрос |
| A3-07 | Concurrent request/consume/lock-generation swap не отменяет чужой run и не удаляет непрочитанный другой запрос |
| A3-08 | Early и admission-time cancel →130, S02 counters0/0/0, target events0; no-cancel →0 и1/1/1 |
| A3-09 | Cancel после подтверждённого prefix сохраняет checkpoint; дальнейшее продолжение не повторяет prefix |
| A3-10 | Cleanup failed/unknown →8, не130; подтверждённый cleanup сохраняет корректный130/143 |
| A3-11 | Root/foreign owner в cancel/recover/emergency отказан до target mutation; trusted ordinary-owner paths работают |
| A3-12 | Raw arbitrary manifest/sudo/shell/traversal/symlink/tampered entrypoint →commands0; valid pinned trusted stop работает с правильным cwd |
| A3-13 | Emergency доступен при занятом installation lock; missing capability честно blocked; PAUSED durable и сохраняется после stop failure |
| A3-14 | Foreign vs unknown inventory/inspect различаются; timeout/output limit/partial stop не получают ложный успех |
| A3-15 | R211-O01: честный recovery outcome, никаких invented committed approvals, explicit fresh review продолжает без replay |
| A3-16 | R221 boundary14, context5, original S03 и genuine v1/v2 migration13 каждый сохраняют semantics |
| A3-17 | Полный setup suite без ослабления/удаления/skip assertions ради green; frozen/command/R2 contracts complete |
| A3-18 | Источники финального прогона = tested-files manifest = восстановленные bytes; owner index/changes сохранены |

Укажи PASS/PARTIAL/FAIL/INCOMPLETE/NOT RUN отдельно для каждого ID. Не требуй, чтобы все14 новых original R3 runners прошли без adapter mapping после изменения механизма: нужны те же проверяемые invariants на новых барьерах. Корректность adapters покажи control cases; нельзя исключить проблемный сценарий из матрицы.

## 9. Evidence и R211-O02 без бесконечных повторов

Сохрани current final-admission checker и completeness contracts. Каждый matrix run валидирует exact ordered/unique IDs, counts/end marker, product predicates, exit/signal. Top-level exit0 или неполный набор успешных строк не равен PASS.

На окончательных bytes выполни один полный intended validation run. Если original runner впервые incomplete, сохрани весь raw run; разрешена одна целевая instrumented попытка первого incomplete runner. Запиши начатый/законченный шаг, exit/beforeExit и незавершённые FS/child boundaries без секретов. Не держи event loop искусственно ради green, не увеличивай timeout без измерения, не склеивай несколько попыток.

Если найдена причина и изменён соответствующий код/harness, повтори затронутый тест и один полный run на новых bytes. Если причина не найдена, честно укажи OPEN; не переписывай продуктовую политику по догадке. Статус O02 не закрывается одним успешным replay. Исторический known-red R211-O01 и deliberate-red baseline отделены от unexpected runtime failure.

Минимум: Node24, `npm --prefix setup ci --ignore-scripts --no-audit --no-fund` в отдельном тестовом снимке; `npm --prefix setup run typecheck --silent`; `npm --prefix setup run test --silent`; R3 matrices, R221/current inherited matrices. Если форматы результата обоснованно уточнились по разделу7, делай отдельный mapped checker, сохраняя исходный oracle и объясняя каждое отличие; не выдавай изменение expectations за исправление auto-resume.

## 10. Scope и качество реализации

Исправления делай последовательно внутри этого прохода: identity/lock → cancel → emergency → recovery outcome → полный regression/evidence. Небольшие общие helpers предпочтительнее копирования checks в каждый verb. Новые protocol routines должны быть читаемы, с понятными фазами и error paths. В затронутых местах распиши чрезмерно длинные строки; не форматируй весь repository.

Не добавляй dependencies/pins без конкретной необходимости и объяснения. Не создавай процесс-local trust cache, общий shell executor, fake success, silent downgrade или автоматическую очистку чужих locks/resources. Проверяемые данные и auth decisions не должны зависеть от `lastConfig`.

Не реализуй здесь весь process supervisor, реальные privileged root writes/S03 cutover/timer/rollback, Docker host installation, OAuth/live budgets, backup/restore/update или отсутствующие M0/M1/M2. Минимальная process-liveness часть и доверенный emergency dispatch входят в R3, но не закрывают Q1B/Q2. Не объявляй все AF пункты закрытыми по этой матрице.

## 11. Артефакты и handoff

Подготовь локально:

1. `docs/audits/remediation-q1a-r3-<actual-date>.md`: исходные/финальные identities, changed files, короткое описание lock/cancel protocol, matrix A3-01…18, O01/O02, фактические команды/результаты, known-red vs unexpected failure, NOT RUN и открытые границы.
2. `audit/evidence/q1a-r3-<actual-date>-local/full-local.patch`: полный воспроизводимый diff от названной base, включая новые файлы/binary/deletions. Owner layer отдельно от agent delta, если исходная рабочая копия уже изменена. **Не использовать index.**
3. `tested-files.sha256`: полный набор source/config/schema/package/test inputs, реально использованных финальным run; не только изменённые файлы.
4. `evidence.zip` + `evidence.zip.sha256`: команды, версии/actual UID vs fake identity, raw stdout/stderr/exits, baseline/final/adapted runners, checkers/mapping, before/after evidence, reconstruction verification и краткий README.

Пакет должен восстанавливаться из named base без index и без повторного применения одинаковых новых файлов из patch и tar. Прежде упаковки один раз проверь reconstruction и совпадение всех tested hashes. Если new-files.tar нужен, явно укажи, является он альтернативой patch payload или дополнением. Не рекурсивно включай старые evidence ZIP, node_modules/dist, transient temp trees и весь repository: достаточно используемых runners/fixtures плюс точных исходных identities. Не упаковывай credentials или машинные секреты.

В финальном ответе: что закрыто на code-level, что частично/открыто, фактические tests, NOT RUN, пути5 выдаваемых файлов и одно действие владельца — передать пакет reviewer. Не проси владельца запускать privileged paths/VPS или выдавать реальные credentials для завершения этого локального задания.

Напоминание: **никаких commit/push/branches/worktree/PR/index/merge/tag/release/deploy; всё остаётся локально**, включая любые дальнейшие промпты, которые ты создашь.
