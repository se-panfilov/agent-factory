# Copilot — Q1A-R2.1.1: S03 продолжение подтверждённых операций без replay

## 0. Задача и обязательные ограничения

Выполни **только Q1A-R2.1.1** по `reviews/agent-factory-r21-audit-d8728f5.ru.md`: исправь **R21-F01 и R21-F02**. Нужны рабочий локальный код, независимые regression proofs, честный отчёт и воспроизводимый пакет. Исходные R2-F01/F02 закрыты; R2.1 пока PARTIAL из-за A21-08. Не начинать R2.2/Q1B/Q2/M0/service/live самостоятельно.

**НЕ делай коммиты, НЕ пушь, НЕ создавай ветки, worktree или PR. НЕ выполняй merge/tag/release/deploy. НЕ используй git index для упаковки, включая `git add -N`. Все изменения остаются локально. Сохраняй эти запреты во всех следующих генерируемых промптах для ИИ-агентов.** Публикация владельцем не входит в твою задачу.

Сохрани чужую работу и dependencies. Нельзя reset/clean/stash ради чистого дерева. Начни с read-only HEAD/tree/branch/status/diff; запиши initial staged/unstaged/new-file owner layer и index checksum. Для reconstruction используй обычные временные папки, без веток/worktree/staging.

Прочитай `AGENTS.md`, этот промпт, новый аудит, report R2.1, `setup/docs/plan-admission-r21.md`, CONTRACT C06/C07/C08/C09/C13 и затрагиваемые tests. Это явно назначенный cross-cutting remediation; допустимы focused core/stage изменения, необходимые для общей модели прогресса. Нет разрешения ослаблять контракт или отмечать production-ready.

## 1. Исходная версия и что сохранить

Проверенный master: **`d8728f56e847a9da75b9f21d8e6e6725a9bd295e`**, tree **`445baea7169ddfb572d1638caad9ef1b38272781`**. R2.1 package base: `ca6d0b6f2a75f3c97a80468bbc2bdcbe2db7a4ff`. Manifest 143 файлов SHA-256 `75973014385506fd0228e64c4d0165effdb38b267c3c94f2aa3c20ae4685ae8c`; patch `1abd4c0fd235ebe0d215da171bb57aeecde4c2de0bc85bf1fce2e57a5b066b67`.

Если actual HEAD иной, зафиксируй delta; не подменяй actual base указанным SHA и не теряй owner layer. Проверяющий независимо получил 429/429 tests, 33 frozen assertions, 37 command assertions и 39 R2 checker assertions. Числа пересекаются: 37 включает агрегат прежних 33; 39 включает служебные checks. Не складывать их в «109 уникальных сценариев».

Обязательно сохранить: independent trusted producer policy; отказ stripped/wrong gates и semantic tampering; 30-minute plan TTL и strict timestamps; post-lock/per-action request checks; gate expiry без renewal; отсутствие implicit re-plan в resume; state/journal generation/recovery guards; R1.6 checked absolute Node command entry; Docker session/progress gates; SSH policy B; generic S08/S14 containment; ordinary-owner admission. Не менять уже принятый R1.6 без нового доказанного основания.

## 2. Доказанные дефекты

**R21-F01.** После настоящего plan/approve/apply S03 и cancel на подтверждённой границе операция имеет receipt/checkpoint, `in_flight_operation=null`, exit130. Новый engine/stage instance с неизменными фактами и ещё действующим plan вызывает `resume` и получает exit4 `s03_observation_drifted`. Происходит после install, stage, arm, cutover и tailnet. Причина: core восстанавливает completed receipts, но не previous receipt; S03 admission/apply сверяется с исходной observation вместо доказанного postcondition предшественника.

**R21-F02.** После той же отмены явный новый plan + новые approvals + resume даёт exit0, но повторяет уже завершённые effects. После cutover итоговые счётчики install/stage/arm/cutover/tailnet/disarm = **2/2/2/2/1/1**, вместо **1/1/1/1/1/1**. S03 observation-derived IDs меняются после собственных effects, новый plan содержит весь каталог, exact-ID enrollment не переносит progress. После tailnet повторяются и первые пять действий. Это существовало до R2.1; не представлять это как впервые возникший регресс.

Reviewer runner: `evidence/access-continuation-probes.cjs`; oracle: `evidence/check-access-continuation.py` в reviewer ZIP. Настоящие engine/S03; внешние операции — counters/observation, отмена — через продуктовый `requestCancel`; state и receipts не подделываются. 13 cases: happy path, по две ветви resume/re-plan после шести шагов. На master **3 desired PASS / 10 FAIL**. Контроль после уже выполненного disarm проходит. На baseline та же итоговая пропорция; partial old resume ошибался `gate_not_approved` из-за implicit re-plan.

Не «исправляй» эти counterexamples заменой на synthetic stage, изменением ожидаемых counts, удалением checkpoint или автоматическим новым approval. Один exit0 без проверки counts недостаточен.

## 3. Восстановление контекста без process-local зависимости

Сделай общую согласованную модель trusted plan → known operation progress → current admission. Перед первой оставшейся операцией нового запуска восстанови необходимый S03 predecessor context из **admitted durable evidence**.

- Проверь stage/config binding, reviewed policy, operation identity/sequence и актуальные ресурсные invariants. Нельзя просто взять последний элемент массива receipts, последний journal event, любой receipt того же resource или значение из submitted plan.
- Данные о завершении должны соответствовать реально опубликованному checkpoint/manifest. Policy metadata не заменяет существующий evidence admission и не легализует unknown/in-flight effect.
- Восстановление должно работать и в предварительной all-stage admission, и в stage execution context, и в S03 внутренней проверке. Не оставляй один из этих путей зависимым от предыдущего вызова в том же процессе.
- При неизменных facts и действующих approvals обычный resume продолжает remaining operations без нового review, без ложного drift и без повторения известного эффекта.
- Проверка текущих postconditions обязательна. При чужом изменении SSH/firewall inputs, ownership, pins, manual readiness либо новой policy — прежний план не разрешает эффект. Дай typed refusal до target intent/effect и сохрани известный progress.
- Не сохраняй произвольную полную переменную stage instance в state. Используй минимальное валидируемое доказательство и существующий механизм durable publication.

## 4. Explicit re-plan должен сохранять доказанное завершение

Раздели смысловую identity действия, ожидаемые входные данные и подтверждение завершения. Observation hash может быть admission constraint, но его законное изменение после собственного эффекта не должно автоматически превращать уже выполненный шаг в новое действие.

Выбери простой согласованный дизайн: stable operation identities с отдельными constraints либо строго проверяемая reconciliation old/new policy. Кратко обоснуй выбор в design note. Не добавляй второй несогласованный список разрешённых gate names.

- Новый review должен представить/исполнить только оставшуюся необходимую работу или иметь однозначное core-validated представление уже завершённых шагов. Submitted JSON не может сам объявить шаг complete.
- Перенос completion разрешён лишь при доказанном семантическом соответствии операции, security policy и актуальных postconditions. Сравнения только по stripped hash suffix, string prefix или resource ID недостаточно.
- Сохранить order и обязательные orchestration steps. `observed.status=verified` для части ресурсов не позволяет пропустить arm/cutover/tailnet/disarm, необходимые для текущей незавершённой последовательности.
- **Arm и disarm имеют общий resource ID.** Нельзя принять receipt одного действия за receipt другого. Учитывай, что текущий manifest компактизирует completed receipts по stage/resource; не предполага́й наличие каждого исторического receipt. Используй доказанную цепочку/инварианты, а не неподтверждённую историю.
- Проверка исторического промежуточного шага не обязана требовать byte-equality всей его старой observation после последующих легальных effects; но она обязана доказать допустимый переход и текущие invariants. Нельзя просто игнорировать изменившиеся hashes.
- Новые gates/resources/risks/pins не получают approval автоматически. Новый план имеет свою identity и требует свои approvals. Продолжение истёкшего старого плана запрещено, продление TTL в resume запрещено.
- Legacy R1.6/R2.1 evidence с observation-derived IDs обработай явно. Допустим доказанный перенос после review; неизвестные/неподдерживаемые данные — typed refusal с сохранением evidence. Не удалять basis/receipts и не обнулять progress для получения зелёного результата.

Если после реального внешнего drift нужна повторная reconciliation mutation, это отдельная явно описанная новая операция после нового review. Такое поведение нельзя использовать для оправдания replay в неизменных reviewer fixtures.

## 5. Scope и качество реализации

Основной scope: `core/engine.ts`, `core/policy.ts`, необходимые internal types/plan helpers, `stages/access.ts`, tests/docs/evidence. Дополнительные production files менять только с объяснением зависимости. Сохрани runtime/public CLI/config/state/plan formats этого пакета. Полный C13 serialization/context binding остаётся R2.2 OPEN.

Не переписывай state/journal recovery protocol, не вводи слабый parallel authorization store и не добавляй ручное редактирование state hashes. Если внутренний metadata format действительно нужно расширить, задокументируй версию, строгую проверку, legacy policy и crash publication на существующем protocol; не выдавай unsupported старую запись за разрешение.

Исправляемая security-critical logic должна быть читаемой: обычное форматирование, короткие именованные predicates/helpers, явные invariants для predecessor selection и carry-forward. Не создавать длинные строки из нескольких state mutations и вложенных тернарных проверок. Не устраивать массовый rename/format вне scope.

Нет необходимости реализовывать настоящие sudo/SSH/UFW/timer операции в этом пакете. Сохрани их текущий production blocker; не маскируй stub как успешно квалифицированный path.

## 6. Приёмочная матрица

| ID | Тест | Обязательный результат |
|---|---|---|
| A211-01 | Исходный reviewer S03 runner на baseline и fixed, без изменения oracle | Baseline 3/13 desired PASS, fixed **13/13**; baseline failure функциональный, не ошибка harness |
| A211-02 | Новый engine после cancel на каждом из install/stage/arm/cutover/tailnet checkpoints, старый действующий plan | Продолжение exit0, final verified, каждый эффект ровно один раз, timer disarmed; отсутствуют лишние intents |
| A211-03 | Та же матрица через explicit plan/review/new approvals | Завершённые effects не повторяются; final counts `1/1/1/1/1/1`; корректный remaining plan |
| A211-04 | Happy path без отмены и отмена после disarm | Работают как раньше; нет blanket refusal или повторного cutover |
| A211-05 | Отдельные owned subprocesses S03, fake facts на диске | Раздельные plan/approve/apply-cancel/resume и re-plan cycles, нет общей памяти stage; PIDs и counts в evidence |
| A211-06 | Несколько последовательных остановок одной установки на разных checkpoints | Progress накапливается корректно; последующие resume/re-plan не теряют предыдущие известные effects |
| A211-07 | Clock пересекает TTL после S03 checkpoint; старый resume, затем explicit fresh review | Old resume blocked без нового effect; fresh reviewed continuation без replay; gate TTL не обновляется in place |
| A211-08 | Значимый внешний drift после pause: content/ownership, pins, manual prerequisites; unchanged positive control | Drift блокирует target intent/effect; чужие изменения не нормализуются как собственные; evidence сохраняется |
| A211-09 | Отсутствующий/неподходящий predecessor proof, wrong stage/config/operation, arm/disarm collision | Нет доверия любому «последнему receipt»; typed refusal; без auto-repair/удаления evidence |
| A211-10 | Unknown effect/in-flight и crash между effect/verify/checkpoint/binding | Не replay; не false verified; прежние recovery rules и fault matrices сохранены |
| A211-11 | Изменение gates/resource/risk/constraints после own progress и tampered submitted plan | Независимая policy остаётся строгой; никаких auto approvals или «исправления» submitted JSON при apply |
| A211-12 | Полный regression/evidence | Все прежние 429 tests сохранены; R2 original probes, 33 frozen/37 command assertions, S00…S07 composition, Docker old/new session остаются зелёными |

Для A211-08 тестируй как прежний действующий plan, так и явный новый review там, где он законен. Не требуй успешного обхода неустранённого security violation под новым approval.

Для A211-09/10 используй реальные core writes/controlled fault barriers и явно обозначенные fixtures. Не подделывай state/checksum так, чтобы тест обходил сам проверяемый evidence admission. Негативному тесту нужен связанный positive control, подтверждающий достижимость happy path.

Отдельно включи own cutover, который меняет соответствующие SSH/firewall content hashes, а не только bool publicExposure. Разрешаются только ожидаемые подтверждённые изменения; manual/pin/ownership drift не должен попадать под широкую normalization. Не объявляй всю реальную SSH/UFW реализацию квалифицированной этим fake adapter.

Проверяй return code, intents, effects, receipts/checkpoints, final state, rollback timer flag и отсутствие replay. Не считать «exit0 и где-то verified» достаточной приёмкой. Не раздувай число tests копиями assert; parameterized matrix с явными строками достаточна.

## 7. Независимые проверки и безопасный запуск

Сначала заморозь reviewer inputs/runners и запусти новую S03 матрицу на actual baseline. Её исходный harness возвращает 0, но desired-product oracle должен вернуть **1 с 10 failures**. Это ожидаемый red result. Начальная ошибка reviewer exit-code assertion сохранена в историческом log и исправлена: контрактная отмена — **130**, не 6; не использовать ошибочный intermediate log как product proof.

Команды для неизменённого S03 runner после сборки target tree:

```text
node evidence/access-continuation-probes.cjs /absolute/target/tree > access.jsonl
python3 evidence/check-access-continuation.py access.jsonl --expect fixed
```

В этих командах передай реальные пути из своей среды; не создавай файл-заглушку по отсутствующему пути. Reviewer ZIP README содержит порядок восстановления target tree и другие runners. Если internal API изменился, сохрани original runner, отдельный минимальный adapter и rationale; expected behavior/counts не ослаблять.

В итоговой обычной временной reconstruction:

```text
node --version
npm --version
npm --prefix setup ci --ignore-scripts --no-audit --no-fund
npm --prefix setup run typecheck --silent
npm --prefix setup run test --silent
```

Реальный Node major24, без подмены `process.versions`; записать Node/npm/OS/arch/UID. Reviewer исходные R2 probes сравнивать с их исходным `ca6d0b6` baseline, потому что на новом baseline `d8728f5` они уже исправлены. Исторический R1.6 command oracle по-прежнему использует `b888082` для своего старого unsafe baseline. Новая S03 regression baseline — actual `d8728f5` или честно отражённый его текущий descendant. Не путать эти три назначения.

Разрешены local temp FS, injected external adapters, безопасные owned child/IPC fixtures, read-only Git, build/tests/packaging. **Запрещены реальные sudo/APT/systemd/SSH/UFW/Docker daemon, credentials/OAuth/provider/model/GitHub writes, VM/VPS provisioning и release/deploy.** Не выставлять host mutation switches, не добавлять NOPASSWD/root installer/shell bypass или изменение Docker socket permissions.

## 8. Отчёт и воспроизводимые выходные файлы

Подготовь `docs/audits/remediation-q1a-r2-1-1-<actual-date>.md` и `audit/evidence/q1a-r2-1-1-<actual-date>-local/`. Используй фактическую дату, а не оставляй placeholder в имени.

Пакет должен содержать:

- Короткий before/after, причины исправлений, design note predecessor proof/stable identity/re-plan/legacy/crash boundaries; честную матрицу R21-F01/F02 и A211-01…12.
- Actual base commit/tree/branch, initial owner layer, index checksum до/после, environment и явное отсутствие нового tested commit агентом.
- Полный local patch с additions/deletions без staging, отдельный new-files payload/manifest, deletions list и точный порядок reconstruction. Если additions уже в patch, tar повторно не применять.
- Tested-files SHA-256 всего релевантного setup input tree; explicit exclusions; report/packaging hashes отдельно, без self-reference. Новые helper/docs/fixtures тоже в manifest.
- Frozen reviewer runner/checker, новые tests/process fixtures, baseline/fixed raw logs и machine counts, commands/argv/cwd/exit/elapsed. Ошибочные intermediate runs сохранять отдельно и классифицировать, не выдавать за final success.
- Evidence ZIP с внутренним SHA256SUMS, внешняя ZIP checksum и README воспроизведения без зависимости от личной неопубликованной session directory.

Действительно восстанови tested tree из actual base + owner layer + patch в пустой временной папке и проверь hashes до/после финальных tests. Не ограничиваться `git apply --check`. После последнего source edit выполнить final validation на соответствующих bytes; повторять suite без изменения/новой причины не нужно.

## 9. Definition of done и следующий шаг

**R2.1.1 local PASS** только если оба continuation paths S03 работают без replay при подтверждённых неизменных facts, foreign/unknown evidence остаётся blocked, новые subprocess/TTL/crash controls подтверждены, прежние protections не ослаблены и пакет воспроизводится. Иначе честный PARTIAL с конкретным остатком; не скрывать нарушение безопасного продолжения за новой blanket refusal.

R2.2 full C13 serialization/binding, R3/Q1B/Q2–Q6, AF backlog и production остаются OPEN. Реальный privileged/SSH/VM/live qualification — NOT RUN. В финальном ответе: что исправлено, фактические результаты, blockers и пути report/patch/manifest/ZIP/checksum.

Следующее действие владельца — передать локальные файлы на независимое review. **Коммит, push, новая ветка/worktree/PR, credentials или VPS для этого не требуются.**
