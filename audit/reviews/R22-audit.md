# Agent Factory — независимый аудит Q1A-R2.2

Дата: 26 октября 2026. Проверенный commit: `ad84212831892d18ab4dbcaab0d1bfecdc103f1b`.

**Вердикт: PARTIAL. Нужен ограниченный R2.2.1 перед приёмкой R2.2.** Изменения существенные и полезные: C13 реализован, исходные проверки контекста проходят, миграция подтверждённого прогресса S03 работает. Однако найдены два воспроизводимых пробела на последней границе допуска: действие после изменения входных данных и сохранение устаревшего одобрения. Кроме того, прежняя проблема неполных проверочных прогонов воспроизвелась вновь.

Это аудит обновления установщика, а не повторная квалификация всей фабрики. Production, реальные привилегированные операции и приложение фабрики этим этапом не закрываются. Уверенность в двух локально воспроизведённых выводах — **98%**; причина нестабильности общего прогона **не установлена**. Процент не является оценкой вероятности безопасности production.

## 1. Какая версия действительно проверена

| Объект | Проверенное значение |
|---|---|
| Master на момент получения | `ad84212831892d18ab4dbcaab0d1bfecdc103f1b` |
| Tree | `5ceab7c5de2838555f7a3eae12bd01f6c4635832` |
| Actual base Copilot | `f12791cf8416fc115d45246f0531ce103fa5e2e8` |
| Предыдущий проверенный setup | `117a71e3607659e97509b99c1662131c3970c112` |
| Разница actual base с предыдущим setup | Нет; отличаются только четыре файла прежнего аудита |
| Входной evidence ZIP | SHA256 `bcc9f3a25ae693d4922ed39d5e81755178d20874dfd6d7341fbcbb30941a030e` |
| Входной full-local.patch | SHA256 `052bfea0e9909e163b98043d23e4166f4063c68338ae99af3b02ea4590f63869` |
| Входной tested-files.sha256 | SHA256 `40750081b9109e98c46fe9bed1a4522d92e19f2ef31e9ef7784184b2dad9bc68` |

Все пять вложений последнего сообщения совпали с опубликованными файлами `../evidence/q1a-r2-2-2026-10-26-local` в этом commit. В ZIP 313 записей; CRC и 312 внутренних контрольных сумм прошли. Actual base + full patch восстановили все 157 файлов manifest. Manifest покрывает все отслеживаемые входы `setup`.

Проверка выполнялась в обычной отдельной копии `git archive`. После тестов совпадают все **157/157 входов setup и 609/609 отслеживаемых файлов snapshot**. Исходный checkout, его HEAD, ветка, пользовательский untracked-каталог и index оставлены без изменений. Коммитов, push, веток, worktree, PR, staging или деплоя reviewer не делал.

Отчёт Copilot фиксирует изменения index во время его работы и сохраняет соответствующие снимки. Происхождение этих изменений независимо не установлено; сам факт смены hash не доказывает, что staging выполнял агент. Публикация владельцем в master не нарушает запрет на публикацию агентом.

Доказательства: `evidence/source-identity.json`, `input-verification.json`, `reconstruction.json`, `reviewer-initial.json`, `reviewer-final.json`, `reviewer-hashes-after.json`.

## 2. Что подтверждено положительно

Изучены изменения engine, plan/schema/format, контекста, policy/progress/history, state, process/filesystem adapters, новые тесты и документация; проверено назначение новых конкретных actions в стадиях. Изменение `setup` затрагивает 59 файлов. Отдельно проверялись миграция, публикация review, сохранение original receipts и отсутствие новых обходов допуска через legacy plan.

| Результат | Независимое подтверждение |
|---|---|
| Typecheck | PASS |
| Основной setup suite | **485 passed, 0 failed, 0 skipped** |
| Исходные B01–B05, actual base | 2/5 desired; исторический дефект сохранён как red |
| B01–B05 после R2.2 | **5/5 desired**: foreign machine, новый boot и изменённый lock блокируют старый запуск; положительный сценарий работает |
| Исходные S03 continuation/re-plan | **13/13** |
| Genuine v1 из `6281df5` → C13 с явным review | **13/13** |
| Genuine v2 из `f12791c` → C13 с явным review | **13/13** |
| Полная подматрица C01–C12 | Все 12 сценариев + META получены; это часть frozen suite |
| R2 admission measurements | 8/8 текущих сценариев с полным META; общий составной checker не завершён |

Эти числа пересекаются по смыслу; их нельзя складывать в число уникальных доказательств безопасности. Матрицы S03 используют настоящий engine и stage, но внешние эффекты подменены контролируемыми adapters. Это не реальный SSH/firewall cutover.

Качественные улучшения:

- Публичный plan теперь плоский C13; consumer проверяет schema, canonical hash, конкретные actions, полную producer policy, target и closure. Пересчитанный hash сам по себе не разрешает подменённые операции.
- Проверяются реальные идентификаторы хоста и audit login session; неизвестная identity не превращается в разрешение. Новый boot/login требует свежего review, сохраняя доказанный прогресс.
- Читаются и валидируются фактические bytes version lock. Для применимых стадий хешируется фактический archive; host-only scope не требует отсутствующего M0.
- Review публикуется как `prepared → plan → committed`. Prepared/malformed/foreign review не является разрешением. Core metadata не принимается из обычного stage observation.
- Policy v3 сохраняет catalog/frontier и привязки operation–attempt–receipt. Genuine legacy progress переносится через явный review; исходные публикации не переименовываются в новое доказательство.
- TTL проверяется независимо от gates; собственный завершённый effect может сохранить checkpoint, после чего просроченное разрешение блокирует следующее действие.

Среда reviewer: Linux x86_64, Node **24.22.1**, npm **11.9.0**, фактический UID **0**; target/owner identity явно injected как Ubuntu 24.04 amd64 / UID 1000. Ни запуск под настоящим ordinary owner, ни PAM/SSH session, ни sudo этим не квалифицированы. Copilot проверял другую локальную среду: macOS arm64 / Node 24.12.0.

## 3. R221-F01 — изменение входов во время последней проверки не блокирует первое действие

**Приоритет P1; блокирует приёмку R2.2. Требования A22-05/06/13 выполнены не полностью.**

В [`engine.ts`, строка 1307](https://github.com/se-panfilov/agent-factory/blob/ad84212831892d18ab4dbcaab0d1bfecdc103f1b/setup/src/core/engine.ts#L1307) проверяются bytes config/plan. После этого выполняется ещё один асинхронный `assertPlanContext`, затем публикуется intent и вызывается `stage.apply`. Новая проверка config/plan после этого context capture отсутствует.

В [`plan-context.ts`, строка 56](https://github.com/se-panfilov/agent-factory/blob/ad84212831892d18ab4dbcaab0d1bfecdc103f1b/setup/src/core/plan-context.ts#L56) version lock читается **до** хеширования archive. Archive допускается до 1 GiB, hashing budget — до 120 секунд. Изменение уже прочитанного lock во время этого hashing не обнаруживается перед текущим действием.

Контролируемые пробы не заменяют hash результат или engine: они меняют другой реальный файл в точке завершения разрешённого чтения. Внешние APT/release effects остаются fake.

| Проба | Что изменено | Фактический результат | Требуется |
|---|---|---|---|
| S02, положительный контроль | Ничего | exit0; refresh/simulate/install = 1/1/1 | Сохранить |
| S02, final context | Bytes config | exit8 `request_changed_after_read`, но **refresh уже 1**, simulate/install 0 | Отказ до первого effect/intent |
| S02, final context | Bytes plan | То же: **refresh уже 1**, есть checkpoint | То же |
| S05, положительный контроль | Ничего | exit0; extract 2, materialize 1, probes 3 | Сохранить корректную последовательность |
| S05, final archive hash | Валидный version lock, изменён Docker CE pin | exit8 `context_version_lock_drift`, но **extract уже 1** | extract/materialize/probes = 0 |
| S05, final archive hash | Bytes config или plan | exit8 `request_changed_after_read`, но **extract уже 1** | То же |

В пробах config/plan добавляется newline: это проверяет обещанную неизменность прочитанных bytes, не выдаёт подмену форматирования за исполнение чужой команды. Отдельная проба lock меняет содержательный pin. Положительный S05 вызывает extract дважды намеренно: отдельные `release.extract` и `release.materialize` используют собственные staging paths. Это не новое замечание о replay.

**Факт:** отказ запаздывает до следующей операции; первая операция уже получила intent/effect/verify/checkpoint. **Не доказано:** выполнение произвольной команды, реальная установка чужого pin или эксплуатация root. Тем не менее эффект после обнаруживаемого изменения входов нарушает заявленный допуск, в том числе перед потенциально привилегированной APT-операцией.

Исправление: согласованный финальный допуск после всех длительных probes/hash reads, с повторной проверкой уже прочитанных входов перед intent. Простого переноса одной проверки config недостаточно: version lock также может устареть во время hashing archive. Не маскировать проблему увеличением TTL, повтором операции или автоматическим обновлением review. Граница с произвольным OS-level race/root filesystem остаётся отдельным Q2.

Доказательства: `context-boundary-probes.cjs/.jsonl`, `release-boundary-probes.cjs/.jsonl`, `boundary-fixed-oracle.json`. В S05 JSONL сохранён stack, показывающий именно последний `assertPlanContext` перед первым effect.

## 4. R221-F02 — gate approve сохраняет одобрение после изменения проверяемого контекста

**Приоритет P2; блокирует A22-09/13.**

[`runGateApprove`, строка 1706](https://github.com/se-panfilov/agent-factory/blob/ad84212831892d18ab4dbcaab0d1bfecdc103f1b/setup/src/core/engine.ts#L1706) проверяет context, затем вызывает `admitPlanPolicies`. Во время этих async probes входы могут измениться. После probes повторяются TTL и сохранение gate, но request/static context повторно не проверяется.

Настоящие SetupEngine/S02 + fake APT observation дают три завершённых отрицательных сценария: во время observation меняются bytes config, bytes plan либо валидный version lock. Во всех случаях команда возвращает **exit0**, gate имеет **`approved`**, durable state изменён. Все три соответствующих fault-off контроля успешно одобряют неизменный запрос.

Вызовов APT в этих gate-пробах нет. Обычная проверка изменённого lock на входе в последующий apply уже работает; поэтому это не доказательство отдельного обхода apply. Но предыдущее ТЗ прямо запрещает одобрять недействительный plan в расчёте на последующий отказ.

Исправление: использовать ту же финальную проверку согласованного запроса/контекста непосредственно перед публикацией approval. Typed refusal, gate остаётся неодобренным, receipts/checkpoints и review evidence сохранены. Нельзя помещать запись нового approval в `finally` обходным путём после отказа.

Доказательства: шесть строк `gate-after-probe-*` в `context-boundary-probes.jsonl` и их before/after hashes.

## 5. R211-O02 — общий replay снова INCOMPLETE

**Остаётся OPEN; причина неизвестна. Это прежнее замечание, не третья новая уязвимость.**

Независимо запущен поставленный `validate-r22.py` на точном master snapshot. Основные 485 тестов, context и три S03 матрицы завершились. Позже получены:

- `baseline-adapter-final.jsonl`: **0 строк**, child exit0;
- `fixed-new-probes.jsonl`: **2 из 6 сценариев**, без META, child exit0;
- `fixed-stage-compat.jsonl`: **2 из ожидаемых 5 строк**, child exit0;
- `check-results.py`: exit0 и **27** выданных PASS assertions вместо полного набора 33;
- следующий `check-r16.py`: exit1 на требовании полного frozen-33; общий validator завершился exit1. Составной R2 checker39 не был запущен.

Итак, глобальный validator не объявил ложный успех. Но отдельный checker не доказывает полноту самостоятельно, а воспроизводимость полного набора всё ещё отсутствует. В этом прогоне даже случаи с keepalive/deadline завершались неполно; объяснения «просто добавить таймер» недостаточно. Нельзя без диагностики приписать причину engine, Node, FS или среде.

Полные traced-прогоны Copilot учтены как его evidence, но не выданы за независимый полный PASS. Reviewer не перезапускал общий набор до случайного green и не объединял фрагменты разных попыток в один успешный run.

Следующий шаг: строгая проверка ожидаемых IDs/числа строк/завершения для каждого runner, раздельные stdout/stderr и сохранение первой неполной попытки; ограниченная диагностика причины. Функциональные исправления F01/F02 не следует подменять переписыванием S03 из-за непонятного сбоя harness.

Доказательства: `validation-driver.log`, `independent-bundle/logs/commands.json`, соответствующие raw JSONL, `comparisons/command-assertions.json`.

## 6. Как меняется предыдущая матрица

| ID | Вывод reviewer |
|---|---|
| R22-F01: host/session | Исходные B02/B03 закрыты в локальном scope; production identity не квалифицирована |
| R22-F02: version-lock binding | Исходный B04 закрыт; полный final-boundary binding **PARTIAL**, см. R221-F01/F02 |
| R22-F03: C13/context | Реализован; общая приёмка **PARTIAL** |
| A22-01/02 | PASS local: C13 и исходные 5 context cases |
| A22-03/04 | PASS local: identity/session negatives и fresh-review positives; live NOT RUN |
| A22-05/06 | PARTIAL: начальные проверки проходят, late-read window открыт |
| A22-07/08 | PASS local в выполненных tests: frontier, producer semantics и target/closure |
| A22-09 | PARTIAL: сохраняется stale gate approval |
| A22-10 | PASS local: TTL boundaries и bounded-action continuation |
| A22-11/12 | PASS local в выполненных S03/migration/process/session tests |
| A22-13 | **FAIL новых контролируемых probes**; исходные lock-swap tests этого окна не покрывают |
| A22-14 | PASS local выполненных publication/crash/binding tests; не гарантия всей recovery модели |
| A22-15 | Ограничение и workaround подтверждены |
| A22-16/17 | Unit suite PASS; весь independent regression replay **INCOMPLETE**, общий PASS не подтверждён |
| A22-18 | PASS: attachments/master/reconstruction/hashes совпали |

Новые reviewer probes: **14 полностью завершённых случаев**, 6 положительных контролей проходят; **8 отрицательных случаев не дают требуемого безопасного результата**. Это два дефекта, а не восемь независимых уязвимостей. Desired checker возвращает exit1; отдельный `observed-current` checker возвращает exit0 только для точной фиксации обнаруженного поведения.

Промежуточные версии самих reviewer fixtures сохранены: первая context-попытка остановилась из-за отсутствующего journal до эффекта; вторая ставила barrier раньше последнего context read и корректно получала ранний отказ. Финальная версия выбирает последнюю policy-observation boundary. Первый S05 oracle ошибочно ожидал один extract в положительном сценарии; исправлен на документированные две операции staging. Ни продуктовый код, ни отрицательное требование zero effects не менялись. Эти попытки не считаются окончательным validation.

## 7. Что остаётся за рамками и что делать дальше

R211-O01 воспроизведён: после финального S03/review и восстановления primary — recover0, repeat0, resume8 `context_review_unproven`; явный fresh plan/review/approval даёт resume0 без повторения S03 effects. Prepared review не нужно автоматически превращать в authorization ради зелёного теста. Дальнейшая recovery-модель — R3.

Маршрут: **R2.2.1 → R3 → Q1B → Q2 → Q3 → Q4 → необходимые Q5 → Q6**. R2.2.1 должен быть ограничен двумя подтверждёнными пробелами допуска и надёжностью evidence. Затем — recovery/cancel/locks; supervisor/process environment; реальные минимальные привилегии и sudo/root writes; offline M0 deployment; credentials/live/budget/backup; опциональные service/inference/platforms; квалификация Ubuntu 24.04 amd64. Разработка и production-аудит самой работающей фабрики — отдельная линия работ.

**sudo не закрыт.** В этой версии не добавлено доказательство безопасной реальной цепочки sudo/APT/systemd/SSH/UFW/Docker. S03 cutover/timer markers и fake adapters не подтверждают настоящий rollback или устойчивость доступа к VPS. Новые hashes и gates не заменяют минимальную привилегированную поверхность Q2.

NOT RUN: disposable VM qualification, real ordinary-owner/PAM/SSH session, sudo/APT/systemd/SSH/UFW, Docker daemon, реальные credentials/OAuth/providers/models, production deployment и квалификация приложения фабрики.

Действия владельца сейчас:

1. Передать Copilot `../R221-copilot-prompt.md`, этот аудит и `R22-evidence.zip`.
2. Выполнить только локальный R2.2.1. Сервер, Docker daemon и credentials для этого не нужны.
3. Прислать новый remediation report, полный local patch, tested-files manifest, evidence ZIP и его SHA256. Не поручать агенту коммиты, push, создание веток/worktree/PR или deploy.

Оценка следующего шага: один целевой проход исправлений и повторная проверка; обещать заранее его окончательную приёмку нельзя. Не требуется ещё один общий аудит S03 без нового воспроизводимого регресса.
