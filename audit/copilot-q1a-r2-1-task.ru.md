# Copilot — Q1A-R2.1: trusted plan policy и срок действия плана

## 0. Режим и результат

Выполни **только Q1A-R2.1**: исправь R2-F01 и R2-F02 из `reviews/agent-factory-r16-audit-5fde93d.ru.md`. Нужны рабочий локальный код, meaningful tests, отчёт и воспроизводимый evidence. R1.6 принят локально; R15-F01 не открывать повторно без нового контрпримера.

**НЕ делай коммиты, НЕ пушь, НЕ создавай ветки/worktree/PR, merge, tags, releases и НЕ выполняй deploy. НЕ используй git index для packaging, включая `git add -N`. Все правки должны остаться локально.** Сохраняй этот запрет во всех следующих промптах, создаваемых для ИИ-агентов. Публикация владельцем не является частью твоей задачи.

Не выполняй reset/clean/stash и не удаляй чужие изменения/dependencies. Сначала read-only HEAD/branch/status/diff; зафиксируй initial index checksum и staged/unstaged/new-file owner layer. При dirty tree сохрани и отдели исходные изменения от своих. Не требуй чистого дерева ценой потери работы пользователя. Для сборки/реконструкции используй отдельную обычную временную копию без создания веток.

Прочитай `AGENTS.md`, этот аудит, отчёт R1.6, `docs/automation/CONTRACT.md` C06/C08/C09/C13 и релевантные core/stage tests. Это явно назначенный cross-cutting remediation пакет, не прежний отдельный Pxx. Внутри scope можно менять core/plan/gates и необходимую stage-интеграцию согласованно. Не начинай Q1B/Q2/M0/service/live работы.

## 1. База и приёмка предыдущего пакета

Проверенный master `5fde93d2c470171039698c35478c020085ef66ff`, tree `f8bca0179c0ce0f583c947a6d53e9852f38fba89`. Его setup совпадает с R1.6 local base `420e5456d3e05b1c4f9b7202cacebb82baaf61eb` + patch SHA-256 `067c9c23c2b0120b271b26f59f4d9ffa0db7d1421a134566166cc52faab8ced6`. Tested manifest: 138 файлов, SHA-256 `a95c623dde5996cf6abf4f93d9b03e76fdaef9fe0fc5ca6b6ced11fe0a9de5cb`.

Независимо на Node v24.22.1/Linux: typecheck PASS, **397/397 tests**, 33 frozen assertions, 37 command-identity assertions (последний checker включает агрегат прежних 33). R1.6 W01…W12 принимаются в local scope. Если HEAD изменён, отрази actual base/delta, не подменяй его указанным SHA и не теряй owner layer.

Сохрани: immutable prepared commands, absolute checked Node entry, zero child для option-shaped entry, hashes перед каждой help; engine-created receipts, state/journal generation/recovery guards; Docker account/process membership и durable pause; SSH policy B; generic S08/S14 containment; truthful no-op/optional status и ordinary-owner checks.

## 2. Доказанные проблемы

**R2-F01.** Настоящий engine генерирует S02 plan с `s02-sudo-apt-update`/`s02-sudo-apt-install`. Если удалить stage `required_gates` и все operation `gate_ids`, пересчитать self-hash и выполнить noninteractive apply без approvals, сейчас получается exit0/S02 verified, fake APT refresh=1/simulate=1/install=1. Одностороннее удаление и неверный hash корректно блокируются; одновременное удаление обходит guard. Schema/hash не являются независимой policy.

**R2-F02.** Gate-free plan на настоящем engine исполняется в возрасте 31 минута, а также после clock rollback, когда его creation time на час в будущем. Gate TTL уже существует; требуется самостоятельная проверка plan TTL, включая операции без gates.

Оба дефекта воспроизведены и на R1.5, и на R1.6. Frozen reviewer runner: `evidence/r2-admission-probes.cjs`; исходные machine results: `r2-admission.jsonl` и `r2-admission-baseline.jsonl`. Настоящие только engine и S02 producer; APT effects — counters. TTL stage явно synthetic. Не выдавай эти fixtures за реальные sudo/host проверки.

## 3. Обязательная политика операций независимо от входного плана

Сделай одну понятную границу trusted policy → validated execution. Submitted plan описывает предлагаемые действия; он не может сам отменять security requirements этих действий.

1. Определяй допустимые operations и обязательные stage/operation gates из доверенных stage definitions / canonical producer planning и актуального observation. Один self-hash, совпадение двух JSON-массивов, наличие любого pending gate или список «известных строк gate ID» недостаточны.
2. Проверяй соответствие каждого operation действительному producer: parent stage и `stage_id`, уникальный operation ID, kind, resource, risk, preconditions, side effects, timeout/retry policy и обязательные gates. Reject unknown/подменённые/дублированные операции; нельзя переименовать ресурс, заменить mutate на harmless kind или убрать precondition/gate, оставив тот же adapter effect.
3. Stage-only requirements остаются обязательными даже при пустом operations. `optional`/capabilities берутся из trusted stage/config policy и не понижаются редактированием plan. External prerequisite вида `*-required` не становится manual approval.
4. Проверяй, что action sequence не содержит недопустимых перестановок или пропусков обязательных шагов. Пример S02: нельзя убрать simulation либо изменить resource/identity install и получить прежний privileged effect. Для законного skipping нужен текущий verified ресурс или durable, проверенное доказательство завершения — не произвольный отсутствующий элемент JSON.
5. Сохраняй DAG/profile/entrypoint checks. Explicit `plan --stage ID` и его prerequisite closure законны; нельзя требовать, чтобы любой stage-specific plan совпадал с полным `config.selected_stages`. Provenance explicit target и полный public format остаются R2.2; не заявляй закрытие этой более широкой границы.
6. Stage admission и engine должны применять одну модель operation identity. Выбери ясный дизайн: canonical fresh stage plan с корректной reconciliation собственных завершённых операций либо общий typed operation-policy API. Не создавай второй несогласованный список gate requirements, который расходится с producer при следующем изменении. Объясни выбор в коротком design note.
7. **Не переписывай submitted plan и не добавляй автоматически недостающие approvals.** Если нужна новая операция, ресурс, риск или gate — typed refusal и инструкция создать/рассмотреть новый план. Нельзя молча выполнить freshly regenerated plan под одобрением старого.

Обязательные refusal cases должны завершаться до target operation intent/effect и до вызова опасного adapter. Read-only observation и необходимые lock действия допустимы. Не «лечи» state/journal, не стирай старые receipts и не помечай уже известный progress unknown из-за plan validation failure до effect. Явно различай refusal до intent, известную завершённую операцию и действительно неизвестный исход.

Выбирай typed errors в существующих ExitCode: malformed/policy-inconsistent plan → schema/semantic refusal, actual drift →8, отсутствующий/expired approval →4, integrity/security violation →9 по действующему контракту. В report зафиксируй точную таблицу. Нельзя вернуть exit0 с manual action вместо отказа.

## 4. Актуальность после lock и внутри последовательности

Сейчас config и plan читаются до `acquireLock`. Проверь их после получения lock, прежде чем полагаться на них для admission. Если за время получения lock изменились значимые config/plan bytes/identity, не выполняй старую in-memory команду и не переключайся незаметно на новый plan. Typed refusal с повторным plan/review, без target effects.

Проверь policy на актуальных stage observations под lock. Значимый drift с сохранённым прежним статусом `planned` тоже важен: проверка только «раньше verified, сейчас не verified» недостаточна. Перед каждым effect сохраняй stage-specific admission, TTL и approvals. Не требуй полного byte-equality observations с timestamps/volatile counters: для security нужны определённые существенные поля.

Особая осторожность с **собственными разрешёнными переходами**: после metadata refresh, materialization, group update и checkpoint current observation законно меняется. Нельзя сравнить следующую операцию с исходным snapshot буквально и навсегда заблокировать happy path. Используй доказанные predecessor receipts/current invariants и ожидаемый переход. Не принимай изменение только потому, что оно «похоже» на свой эффект.

Сохрани restart/resume из подтверждённых operation checkpoints; известные completed effects не replay. Unknown effect остаётся blocker. Новый Docker login требует fresh remaining plan/gates по текущей модели; прежние approvals не переносятся на иной plan автоматически. Проверка policy не должна возвращать зависимость stages от предыдущего plan в том же процессе.

## 5. Plan TTL и время

Используй **один injected clock**. Ближайший пакет реализует контрактный предел 30 минут для текущего `created_at`; полный переход public serialization к C13 `generated_at/expires_at` выполняется R2.2. Не называй текущий формат полностью соответствующим C13 и не меняй CONTRACT ради удобства.

- Timestamp обязан быть корректным конечным моментом времени по строгой документированной ISO/UTC форме, которую генерирует planner. Проверка одного regex-префикса или `Invalid Date` с ложным сравнением недопустима.
- `now >= created_at + 30 min` — expired, в том числе без gates. План, созданный в будущем, отклоняется; не вводи большой неоговорённый clock-skew допуск.
- Проверяй до первого effect после lock и перед каждым следующим. При переходе границы срока между операциями следующие effects=0, прежний verified progress сохраняется. Не убивай APT в середине действия ради TTL; оно завершается/сверяется по своей bounded policy, а затем новые actions блокируются.
- Apply/resume/gate approve не могут продлить существующий plan. Re-plan — явная новая identity и новые approvals там, где они требуются. Старые gate expiry не обновлять автоматически.
- Expiry самого плана и expiry gate — разные проверки. Существующие gate tests до/на/после TTL и запрет approve expired должны остаться зелёными.
- Plain status остаётся recorded-data/read-only. TTL refusal не должен автоматически уничтожать plan или данные recovery.

Пересчёт self-hash не должен превращаться в альтернативу trusted policy. Этот пакет не заявляет криптографическую аутентификацию plans и не защищает от полностью скомпрометированного доверенного owner, способного менять сам installer. Нельзя закрыть F01 одним хранением «любого hash, который передал клиент».

## 6. Scope и явно отложенные части

Разрешены focused изменения `setup/src/core/plan.ts`, `engine.ts`, при необходимости `gates.ts`, внутренних types/helper и необходимых stage interfaces/producers, tests/docs/evidence. Не обязательно менять все эти файлы. Для дополнительных production files объясни необходимость.

**Не меняй публичный CLI/config/state/plan schema format в этом пакете.** Улучшить семантическую проверку текущего формата и runtime validation времени можно без нового поля. R2.2 должен отдельно согласованно привести plan к C13 и добавить полный host/owner-session/version-lock/release/observations binding; это остаётся OPEN. Не добавляй произвольную новую schema version или «пустой digest» для прохождения tests.

Не переписывай state generation/recovery protocol. Если нужна интеграция с receipts, используй существующее доказанное чтение и invariants; без ручного изменения state hashes/удаления evidence. Не вводи новый persistent authorization sidecar без обоснованной crash/recovery модели; если это действительно необходимо, конкретно покажи, почему безопасного решения в текущем scope нет, и продолжай независимые исправления.

Вне scope: real sudo executor/host writes, full process-tree cleanup, APT provenance, S03 cutover, M0 release, service/unattended, auth/live/provider/GitHub actions, backup/restore implementation, полный R2.2 contract rewrite. Незавершённые paths остаются blocked/open, не получают fake success.

## 7. Приёмочные тесты

Заморозь reviewer runner и входы. На baseline должны сохраниться реальные R2A03/R2A07/R2A08 failures и positive controls. Если требуется адаптация после изменения API, сохрани оригинал, отдельный минимальный адаптер и обоснование; не меняй oracle «без требуемых approvals эффекта нет». Тесты R1.6 для command identity сохраняются.

| ID | Проверка | Обязательный результат |
|---|---|---|
| A21-01 | R2A03, настоящий S02: удалить оба списка gates и пересчитать hash | Typed отказ до S02 target intent и refresh/simulate/install; все counters 0; без approvals |
| A21-02 | Подменить непустыми неверными gates; удалить один обязательный gate; одинаковые gate IDs у разных operations/resources | Неверный binding не принимается; правильные approvals не теряются и не переносятся |
| A21-03 | Подмена operation parent/stage/id/kind/resource/risk/preconditions/timeout/retry; дубликаты, перестановка, пропуск simulation | Реальные producer semantics не исполняются под изменённым описанием; hash пересчитан в negative fixtures |
| A21-04 | Stage-only gate + operations=[]; forged optional/capability; no-op | Обязательный prerequisite/gate нельзя убрать; корректный verified no-op проходит без effect |
| A21-05 | Fresh exact generated plan, approvals, настоящий S02 с fake APT | refresh/simulate/install ровно по ожидаемому разу; final verified; negative tests не достигнуты blanket отказом |
| A21-06 | Без approvals, неверный self-hash, односторонний gate mismatch | Прежние refusal controls сохранены с понятными typed errors |
| A21-07 | Реальная композиция S00…S07; отдельный stage target + prerequisite closure | Happy path и законный выбор stage сохраняются; unsupported/generic S08/S14 по-прежнему blocked |
| A21-08 | Durable partial progress, новая engine instance, Docker old/new session, own S03/S05 transitions | Нет replay known effects, нет вечного drift на собственной mutation; unknown effects остаются blocker |
| A21-09 | Plan age: fresh, 30min−1ms, ровно 30min, +1ms, 31min; future/malformed/невозможная дата | Только корректный неистёкший plan допускается; negatives без target effects, включая gate-free stage |
| A21-10 | Clock продвигается после первой completed operation за plan TTL | Первая сохраняет checkpoint, второй effect=0; повтор old plan blocked; новый review позволяет безопасно продолжить |
| A21-11 | Изменение config/plan на controlled lock barrier между начальным read и admission | Старый in-memory request не выполняется; новый plan не подхватывается без review; target effects=0 |
| A21-12 | Significant observation drift без изменения общего stage status | Старый plan непригоден; свежий корректный plan после review проходит |
| A21-13 | Expired gate/approve/upsert/resume; rejection без порчи evidence | Срок старого gate не продлевается; ранее известные receipts/journal остаются доступными |
| A21-14 | Полный regression suite и независимые сравнения | Все прежние 397 тестов сохранены; old crash/fault matrices, 33 frozen assertions и R1.6 command probes проходят |

Не заявляй каждый потенциальный вариант A21-03 уже найденным exploit: это обязательные проверки класса дефекта, а не фальсифицированный baseline результат. У каждого отрицательного теста должен быть соответствующий понятный positive control. Проверяй не только return code, но adapter calls, target intents/effects/checkpoints, статус stages, отсутствие replay и сохранение прежнего evidence.

Где важны actual stages, используй настоящие producers с fake external adapters. Для timestamp и controlled concurrency допустим маленький synthetic stage, явно обозначенный как synthetic. Хотя бы один lifecycle тест должен выполняться через раздельные CLI/engine subprocesses, а не зависеть от общей памяти предыдущего plan. Не раздувай число tests идентичными assert-копиями; parameterized cases с перечисленными inputs подходят.

Если к исправлению не требуется отдельное изменение, не добавляй test, зеркалящий частную реализацию: доказывай observable safety contract. Не удаляй старые tests ради зелёной итоговой цифры.

## 8. Безопасная validation

Разрешено: локальные temp FS, injected adapters, безопасные owned child/IPC fixtures, read-only git, typecheck/tests и packaging. Реальный Node major 24, без подмены versions; записать OS/arch/UID. Если тестовая среда UID0, честно отметить, что это не квалификация root deployment.

**Запрещены реальные sudo/apt/systemd/SSH/UFW/Docker daemon операции, credentials/OAuth/provider/model calls, GitHub writes, VPS/VM provisioning, release/deploy.** Не выставляй host mutation switches. Не добавляй NOPASSWD, shell execution, root installer, chmod Docker socket или «временный» env/CLI bypass.

В отдельной итоговой реконструированной копии:

```text
node --version
npm --version
npm --prefix setup ci --ignore-scripts --no-audit --no-fund
npm --prefix setup run typecheck --silent
npm --prefix setup run test --silent
```

Повтори reviewer R2 runner на baseline/fixed. Его baseline output должен отражать **5 safe / 3 unsafe**, а не 8 product PASS. Fixed должен устранить три отрицательных исхода, сохранив controls. Запусти старые frozen comparison и command-identity checkers. Эти проверки могут потребовать source-contract adapters при изменении внутренних сигнатур; реальные expected safety outcomes не ослаблять.

Запиши commands/cwd/exit/elapsed и raw logs. Harness exit0 ≠ продуктовый успех. Initial red tests на baseline должны падать из-за проверяемого дефекта, не из-за отсутствующего модуля/dependencies. Ошибочные промежуточные прогоны сохранять и классифицировать. После последнего source edit выполнить окончательную validation на соответствующих bytes; повторять suite без причины не нужно.

## 9. Выходные файлы без коммита

Создай `docs/audits/remediation-q1a-r2-1-<actual-date>.md` и `audit/evidence/q1a-r2-1-<actual-date>-local/`:

- report с конкретным before/after, production diff, design note trusted policy/TTL/own transitions, таблицей F01/F02/A21-01…14 и PASS/PARTIAL/OPEN;
- identity: actual base commit/tree/branch, initial owner layer, Node/npm/OS/arch/UID, отсутствие нового tested commit, checksum index до/после;
- полный patch с additions/deletions **без staging**; при dirty input отдельно owner layer и agent delta, плюс полная инструкция сборки tested tree;
- явный new-files payload + manifest, deletions list; если additions уже в patch, tar не применять повторно;
- tested-files SHA-256 manifest всего релевантного setup input tree, с новыми helpers/tests/docs и явными exclusions; report/packaging hashes отдельно, без self-reference;
- frozen runners/fixtures, baseline и final logs, actual assertions/counters, meaningful matrix; без secrets и без ссылок на недоступную личную session directory;
- evidence ZIP с внутренним SHA256SUMS, внешний ZIP checksum и README воспроизведения.

Действительно восстанови exact local tree из actual base + owner layer + patch в пустой temporary folder; сверь все hashes до/после итоговых тестов. Сохрани HEAD/branch/index и чужую работу. Не представляй checksum архива как доказательство semantic correctness.

Report должен явно оставить **R2.2 OPEN**: полный C13 plan serialization, host/owner session/version-lock/release/observations binding и оставшиеся concurrency cases не закрыты узким R2.1. Также R3/Q1B/Q2–Q6, AF backlog и production не получают автоматический PASS.

## 10. Definition of done

R2.1 local PASS возможен только если удаление/подмена gates и иной security-semantic tampering не приводит к target effects, план действительно имеет 30-минутную runtime пригодность, invalid/future время блокируется, post-lock checks работают, own-progress/resume/no-op и прежняя suite сохранены, evidence воспроизводим. Иначе честный PARTIAL с конкретным blocker.

Финальный ответ: коротко изменённое поведение, фактические tests/results, remaining blockers/NOT RUN, пути к report/patch/manifest/ZIP/checksum. Не писать «production ready» и не начинать R2.2 самостоятельно. Следующее действие владельца — передать локальные файлы на review; push, credentials и VPS для этого не нужны.
