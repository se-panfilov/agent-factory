# Agent Factory — независимая проверка Q1A-R3

**27 октября 2026, Europe/Amsterdam. Проверенный commit: `e217f397b952942b62e847788dc2e6698ad6d7e5`.**

**Вердикт: PARTIAL.** Строгая identity блокировки и координация acquire/release/recover существенно исправлены; новый явный recovery/review outcome принимаю. Полностью закрыть R3 пока нельзя: остаются пробелы в обработке cancel и emergency, а тестовый пакет зависит от фактического UID. Следующий проход — **ограниченный Q1A-R3.1**, затем, при успешной проверке, Q1B.

## 1. Подтверждённые факты: исходники и пакет

| Проверка | Результат |
|---|---|
| Master на момент получения | `e217f397b952942b62e847788dc2e6698ad6d7e5`, `audit fixes 14` |
| Tree | `41fe20304e340133bd7e217aceea674c466015e3` |
| Parent / named reconstruction base | `b92e833c3d743d2f15975ee6433b453f07f173b8` |
| Предыдущий проверенный продукт | `134ecd884ab77f537f1890b3dd456cc6592090ad` |
| Разница 134ecd → b92e833 в setup | Отсутствует; промежуточная публикация audit-only |
| Совпадение пяти приложений с master | Побайтное, PASS |
| Входной evidence.zip | 387 members, CRC PASS, все 386 внутренних SHA256 PASS |
| Source/runner manifest | Все **270** entries совпадают с master: 166 source inputs + 104 runner/fixture inputs |
| Reconstruction | Named base + full-local.patch **один раз**, все270 hashes совпали; report совпал; index не использовался |
| Изменение setup относительно134ecd | 17 файлов, +918/−466: 6 production, 7 test/helper, 4 docs |

SHA256 приложений:

| Файл | SHA256 |
|---|---|
| remediation-q1a-r3-2026-10-27.md | `466733ed1460381f55463b41f055ededdeca00fb0dad014f5095bb61c154697c` |
| full-local.patch | `3f5b1c0377d1bf4eac66402b581f03f378c131778c804178147675e00c9c90c8` |
| tested-files.sha256 | `f259e816d3e964ae7c2e9006a7fe8e035382ffc4c4a1386f7df348353f6ee0f8` |
| evidence.zip | `393d139d18f0c7fef2fff4b50a4494ba220dba1a3e9fd249c6e3d6d653e3f162` |
| evidence.zip.sha256 | `0861a7250dcc63e790bc099e2235a9da9e9ff3853a3d9dfcd7a029eaa75b5769` |

Исходный checkout владельца не переключался: HEAD `7d845248…`, master, существующий untracked `app/m0-02-runner/.factory-selftest-gC3VLh/` сохранён. HEAD/status/index до и после одинаковы. Проверки выполнены в обычных архивных каталогах. Все270 файлов исходного проверенного снимка сохранили hashes. Production-код reviewer не менял.

Copilot отдельно указал внешний сдвиг HEAD/index до полного первоначального capture и отсутствие bytes самого раннего index/unstaged split. Это честное ограничение provenance. Автор события не установлен. Пакет при этом воспроизводится из названной base и совпадает с опубликованным кодом. Не требую нового цикла ради восстановления уже отсутствующих исторических bytes и не приписываю commit агенту. A3-18 остаётся PARTIAL именно в этой исторической части.

## 2. Подтверждённые факты: независимые прогоны

Reviewer: Linux x86_64, Node24.22.1, npm11.9.0, **actual UID0**, injected application identity UID1000/factory. Copilot: macOS/APFS, Node24.22.1, npm11.17.0, actual UID501. Ни одна из этих сред не равна квалифицированному Ubuntu VPS с реальными привилегированными adapters.

| Прогон | Результат и ограничения |
|---|---|
| Exact master: ci / typecheck | PASS |
| Exact master: полный setup suite | **574 PASS / 15 FAIL**, всего589; skipped/cancelled/todo0 |
| Все новые тесты R3 в этом же исходном run | **74/74 PASS**, точные ordered/unique names проверены |
| Диагностическая копия с тремя исправлениями только test calls | **589/589 PASS**; production bytes неизменны |
| Прежние R221 boundary checks | **14/14 PASS** на диагностической копии с теми же production bytes |
| Context binding | **5/5 PASS** там же |
| Original S03 runner на UID0 | INCOMPLETE после одного positive case: тот же omitted ProcessAdapter в cancel |
| S03 с отдельным explicit-identity runner | **13/13 PASS** на exact master |
| Genuine v1 → C13 / v2 → C13 | По **13/13 PASS** на exact master; историческая первая публикация настоящим старым engine |
| R211-O01 honest recovery | Обе ветки PASS: recover8/repeat8/resume8, затем fresh explicit review/resume0, без replay |
| Frozen / command / R2 comparisons | Mapped frozen33, неизменные command37 и R2-checker39 PASS; counts пересекаются |
| Поставленный R3 adapted runner на UID0 | Exit1, incomplete из-за omitted ProcessAdapter |
| Тот же runner с явным existing test ProcessAdapter | **14/14 PASS**, unchanged product predicates |
| Негативные controls completeness checker | **8/8 PASS** |
| Новые независимые remaining-gap probes | **14 complete / 7 desired PASS / 7 desired FAIL** |

**Не было одного полного независимого зелёного запуска всего пакета.** Исходный validator остановился на15 failures. Диагностический — прошёл589 tests/boundaries/context, затем остановился на S03 identity mismatch. Оставшиеся17 матриц выполнены отдельным continuation run с34 ledger entries. Это отдельные прогоны, а не склеенный «полный PASS». Raw failures, исходные runners, patch адаптации и журналы каждого запуска сохранены.

Три изменения диагностической копии передают уже используемую fixture identity в `requestCancel`: `tests/helpers/r211-access.ts`, `tests/integration/q1a-r22-context.test.ts`, `tests/integration/core-q1a.test.ts`. Внешним S03 и R3 runners понадобилась такая же прозрачная адаптация. Ни root check, ни FS ownership, ни реальные OS identities не подменялись. Попытка отдельного процесса с UID65534 была запрещена контейнером (`EPERM`); тесты в такой среде **NOT RUN**, обход разрешений не выполнялся.

## 3. Что принято и почему

| Прежнее замечание | Итог |
|---|---|
| R3-F01 — owner metadata/liveness | **PASS local**: bounded schema, полная generation, unknown не считается dead; EPERM/proc-stat parsing покрыты |
| R3-F02 — acquire/release/recover race | **PASS local для cooperating participants**: общий mkdir mutex исключает прежнее interleaving, stale handle не удаляет новую generation |
| R3-F03 — cancel | **PARTIAL**: atomic publication, retained matching request и late-admission cancellation работают; semantic-invalid JSON всё ещё игнорируется |
| R3-F04 — emergency | **PARTIAL**: root/raw sudo/manifest/path boundaries усилены; incomplete inventory и exceptional failures не обработаны полностью |
| R211-O01 | **Принят выбранный явный fresh-review outcome**; automatic-resume из prepared review не разрешён |
| R211-O02 | Историческая runtime-причина **OPEN**; новый UID mismatch объяснён отдельно |

Новый `lock-protocol/` сериализует cooperating writers; его нельзя автоматически reclaim после crash. Это допустимый консервативный выбор для локального R3. Он не доказывает защиту от произвольного same-UID/root filesystem writer. Boot change, PID reuse и resource-bearing state честно требуют reconciliation/manual action. Такие ветки не квалифицированы как автоматический production recovery.

Atomic cancel сохраняет принятые bytes при injected write/fsync/rename failures. Read-only consumer не удаляет запрос другой generation. Отмена после длительных admission reads не пропускает следующий эффект; прежний R221 metadata fence сохранён после cancel observation. Это действительные исправления, их нельзя потерять в R3.1.

### Изменения исторических assertions

Переход recover0 → recover8 для prepared/утраченного review обоснован: restored bytes не дают authorization. Теперь есть `review_required:true`, `resume_authorized:false`, понятный fresh-review action; повторный recover не выдаёт ложный успех. Original O01 и C01 auto-success oracles остались known-red. Отдельный mapped C01 проверяет recovered primary/checkpoint и требование review; остальные32 frozen assertions не меняют смысл. Явный review завершает продолжение без повторного S03 cutover.

Замена fixture nonce/date/ticks на валидные значения и statfs bridge для старого FS object оправданы новой строгой схемой. Изменение lock-only0 →8 при неизвестной операции также оправданно. Последующий **harness-only manual quarantine** не доказывает наличие продуктового автоматического reconciler: дальнейшие no-replay assertions принимаются только с этим ограничением. В документации и квалификации это различие нужно сохранять.

## 4. Что исправить: подтверждённые remaining gaps

Приоритеты ниже — инженерная оценка для этого проекта, не CVSS и не заявление о доказанной удалённой эксплуатации. Все новые probes используют actual engine/owned FS и fake внешние эффекты. Реальные sudo/APT/Docker не выполнялись.

### R31-F01 — невалидный современный cancel разрешает продолжение

**Приоритет: высокий. Уверенность в локальном факте:98%.**

В `consumeCancelRequest` parse errors превращаются в `cancel_evidence_unknown`, но schema errors просто дают `false` в boolean expression. Поэтому неизвестный/повреждённый современный запрос неотличим от отсутствия matching cancellation.

Воспроизведение: engine публикует usable lock; через настоящий `requestCancel` успешно записан matching schema2 request, пока APT counters0/0/0. До первого чтения меняется только одно поле файла:

| Case | Изменение | Сейчас |
|---|---|---|
| C-v2-missing-field | Удалён `owner.process_start_ticks` | exit0, APT1/1/1, все12 target journal events |
| C-v2-extra-field | Добавлен неизвестный top-level field | То же |
| C-unknown-version | schema_version99 | То же |
| C-broken-json — контроль | Невалидный JSON `{` | exit8, effects0, events0 |
| C-valid — контроль | Корректный matching schema2 | exit130, effects0, events0 |

Это не доказательство того, что штатный atomic writer сам генерирует такие bytes: fault введён отдельно. Это доказательство неправильного fail-closed чтения невалидного control evidence. Собственная документация R3 обещает refusal для malformed/unsafe evidence. Legacy unbound requests и корректная stale generation проверены отдельно: они не отменяют новый run.

**Требуется:** разделить decoding/schema validation и identity comparison. Schema2 со missing/extra/wrong-type fields, невалидным owner и неизвестная версия должны давать typed8 без нового intent/effect; сохранить файл. Только успешно распознанный разрешённый legacy/stale формат может быть безопасно проигнорирован. Не разрешать malformed JSON посредством широкого «всё старое» fallback.

Источник: `core/lock.ts`, `consumeCancelRequest`; `r31-boundary.jsonl`, cases C-*.

### R31-F02 — отсутствие inventory отключает проверку Docker и даёт ложный успех

**Приоритет: высокий. Факт —98%, вывод о недостаточности emergency-контракта —96%.**

В `emergencyCancel` переменная `docker` становится true только при наличии local inventory с непустым `owned_container_labels`. Комментарий называет inventory advisory, но фактически именно его наличие решает, выполнять ли live discovery.

Использована genuine engine-published trusted deployment fixture из самого R3: approved S05 receipt/journal, проверяемый manifest/content/runtime, fake daemon с own container `aaaaaaaaaaaa` и foreign container `bbbbbbbbbbbb`. Stop/status приложения в этой fixture не останавливают Docker — это делает отдельный Docker adapter.

| Case | Результат |
|---|---|
| E-control, корректный inventory | exit0,5 Docker calls, own container stopped, foreign skipped |
| E-no-inventory | **exit0,0 Docker calls, own container всё ещё running**, PAUSED существует |
| E-empty-inventory | То же при valid local JSON с labels=[] |

Проверено именно влияние локального файла при неизменных fake live facts. Не доказан аналогичный incident на реальном VPS. Однако успешный результат больше не подтверждает завершение emergency для owned ресурсов. По предыдущему ТЗ нельзя полагаться только на local inventory; status приложения не является Docker postcondition.

**Требуется:** known Docker deployment должен проверять текущие owned resources по фиксированной installation identity независимо от отсутствия/пустоты/устаревания advisory inventory. Unknown daemon/ownership/inventory не равны доказанному пустому набору. Если действительно поддерживается no-Docker installation, отсутствие соответствующей обязанности нужно доказать отдельно, сохранив рабочий positive path. Не устанавливать Docker автоматически и не запускать `sudo docker`. Known foreign не трогать; arbitrary labels/IDs не допускать.

Источник: `operations/emergency.ts`, inventory loading и `if (docker)`; cases E-control/E-no-inventory/E-empty-inventory.

### R31-F03 — exceptions выпадают из emergency recovery-протокола

**Приоритет: средний. Уверенность:98%.**

Обычный `CommandResult.exitCode=1` корректно даёт8 `emergency_stop_unconfirmed`. Но rejected promise/throw от adapter не обработан локально. Верхний engine превращает его в6 `unexpected_error` с общей рекомендацией «retry with a fresh plan». Уже подтверждённый emergency prefix и причина сохранения PAUSED теряются из ответа.

| Case | Результат |
|---|---|
| E-return-failure | Typed8, PAUSED сохранён — положительный контроль |
| E-throw-stop | Injected ENOENT при dispatch →6 unexpected_error, PAUSED сохранён |
| E-throw-after-prefix | Own container остановлен и подтверждён; следующий inspect throw EIO →6 unexpected_error, подтверждённый prefix отсутствует в envelope |

Это **не ложный exit0**: отказ имеется. Дефект — неполный результат восстановления, утрата контекста частичного выполнения и неподходящая generic retry-инструкция. Это важнее самого различия чисел6/8. Стандартный NodeProcessAdapter действительно может reject на child `error`; здесь исключения безопасно введены fake adapter.

**Требуется:** обрабатывать failures после начала emergency в одном месте, сохранять PAUSED, attempted/confirmed/unknown outcomes и точное дальнейшее действие. Неизвестный/частичный cleanup → typed8. Доказанный failure до запуска какого-либо эффекта можно классифицировать отдельно по C03, но с конкретным emergency error и evidence; не просто `unexpected_error`. Нельзя считать attempted stop подтверждённым и нельзя автоматически повторять mutations. Проверить также PAUSED write/rename/fsync failures и errors при postconditions.

Источник: `operations/emergency.ts`, local `run`; `adapters/process.ts`, child error handler; `core/errors.ts`, generic conversion.

### R31-F04 — тестовая identity передаётся не всеми callers

**Приоритет: средний; блокирует воспроизводимость пакета. Уверенность:99%.**

`requestCancel(..., proc?)` при отсутствии proc использует actual `process.getuid()` и отвергает UID0. В части старых tests/runners engine использует обычного fake owner, но direct cancellation call не передаёт ту же identity. Это даёт15 failures на Linux/UID0 и неполные S03/R3 standalone matrices. На macOS/UID501 fallback не срабатывает, поэтому результаты Copilot и reviewer могут одновременно быть правдивы.

Три точечных test-call изменения дали589/589 без изменения production-кода. Отдельные explicit-identity S03/R3 runner copies дали13/13 и14/14. Все replacements, original raws и hashes приложены. Это подтверждённая причина данного расхождения, **не найденная причина исторического O02**.

**Требуется:** передавать actual fixture ProcessAdapter во все вызовы, включая внешние current-source runners и helper/child paths. Разумно сделать параметр обязательным для внутреннего API и убрать непроверяемое предположение «internal caller уже правильный owner». Historical baseline runners, использующие старый API, сохранять; mapping делать отдельно. Не отключать root checks, не менять `process.getuid`, не пропускать тесты и не объявлять synthetic UID реальным обычным пользователем ОС.

## 5. Полная новая матрица reviewer

| Case | Desired |
|---|---|
| C-none | PASS: обычное выполнение1/1/1 |
| C-valid | PASS:130,0/0/0 |
| C-stale | PASS: stale generation не отменяет новую |
| C-legacy | PASS: legacy unbound не получает authority |
| C-broken-json | PASS:8, effects/events0 |
| C-v2-missing-field | FAIL |
| C-v2-extra-field | FAIL |
| C-unknown-version | FAIL |
| E-control | PASS: own stopped, foreign untouched |
| E-no-inventory | FAIL |
| E-empty-inventory | FAIL |
| E-return-failure | PASS: typed8, PAUSED retained |
| E-throw-stop | FAIL: generic exception outcome |
| E-throw-after-prefix | FAIL: recovery context/prefix lost |

Collector exit0 означает только завершение14 cases. `check-r31-boundaries.py --mode baseline` →0 подтверждает **дефекты**; `--mode desired` →1. Проверяются exact ordered unique IDs, META, hits, counters и продуктовые predicates. Результат не получен подсчётом одних флагов collector.

## 6. Логические выводы и следующий этап

**Вывод, уверенность95%:** нужен один ограниченный remediation-pass R3.1 по четырём пунктам выше. Оснований заново переписывать lock architecture, R221 final admission или committed-review модель не вижу. Число будущих итераций не обещаю: приёмка зависит от фактического результата.

Порядок: R3.1 → Q1B process supervisor/environment/cleanup → Q2 реальные минимальные привилегии и host operations → Q3 offline M0 deployment → Q4 credentials/live/budget/backup → выбранные optional Q5 → Q6 disposable VM qualification. Приложение фабрики и M0/M1/M2 развиваются отдельно. Сейчас не нужны production VPS, credentials или ручной sudo.

Качество кода улучшилось за счёт общих control-files helpers, явной generation и единой процедуры publication. Некоторые security routines остаются чрезмерно сжатыми; читаемость затрагиваемых branches стоит улучшить внутри R3.1. Массовый форматирующий refactor не нужен.

Честные открытые ограничения, не новые обязательные функции R3.1:

- Guard crash и неизвестные ресурсы требуют manual reconciliation; полноценный runbook и реальные adapters нужны до production.
- У существующих M0 manifests без подтверждённого status postcondition emergency может только попытаться stop и вернуть8. Это прямо описано в R3; R3.1 не должен выдумывать отсутствующую app capability.
- Service emergency остаётся unsupported5. Дополнительные service/inference features не являются условием принятия локального R3.1.
- Полный process-tree supervisor, общий deadline многокомандного emergency, реальные root writes/OS races, доступ к Docker API и physical power-loss остаются Q1B/Q2/qualification.
- `privileges.md` и `operations.md` имеют старые общие формулировки рядом с новыми dated corrections. В затронутых строках следует убрать противоречия, не объявляя весь документ текущей production qualification.

## 7. Действия владельца

1. Передать Copilot `../R31-copilot-prompt.md`, этот аудит и `R3-evidence.zip` из общего архива.
2. Выполнить только R3.1 локально. **Без commit/push, веток/worktree/PR, staging/index, merge/tag/release/deploy.**
3. Вернуть report, full-local.patch, tested-files.sha256, evidence.zip и его SHA256. Публикация владельцем — отдельное решение; для review достаточно файлов.

## 8. Ограничения и самопроверка

Подтверждённые локальные выводы опираются на actual code paths, source hashes, сохранённые raw outputs и отдельные product oracles. Уверенность98% относится к этим наблюдениям, **не к вероятности безопасности production**. Для inventory вывод зависит от корректного разделения app-status и container postconditions; в используемой штатной fixture это разделение явно существует.

NOT RUN: реальные sudo/APT/systemd/SSH/UFW/Docker daemon, credentials/OAuth/providers/models, VPS/disposable VM, ordinary-owner/PAM host session, полный TERM/KILL tree, physical crash и production factory qualification. Историческая O02 runtime-причина неизвестна. Полного all-in-one independent PASS здесь нет; диагностические проверки не подменяют исходный failed suite.

Слабое место evidence — часть матриц унаследована и адаптируется к изменяющимся внутренним API. Поэтому сохранены оригиналы, минимальные diff адаптации и новые14 independently written probes. Для следующего шага особенно важно проверять точный error branch: например, изменение manifest после publication может остановиться на proof drift и ничего не доказать о missing-status branch доверенного неизменного release.

Основные исходники привязаны к commit:

- [lock.ts](https://github.com/se-panfilov/agent-factory/blob/e217f397b952942b62e847788dc2e6698ad6d7e5/setup/src/core/lock.ts)
- [emergency.ts](https://github.com/se-panfilov/agent-factory/blob/e217f397b952942b62e847788dc2e6698ad6d7e5/setup/src/operations/emergency.ts)
- [control-files.ts](https://github.com/se-panfilov/agent-factory/blob/e217f397b952942b62e847788dc2e6698ad6d7e5/setup/src/core/control-files.ts)
- [engine.ts](https://github.com/se-panfilov/agent-factory/blob/e217f397b952942b62e847788dc2e6698ad6d7e5/setup/src/core/engine.ts)
- [CONTRACT1.0.0](https://github.com/se-panfilov/agent-factory/blob/e217f397b952942b62e847788dc2e6698ad6d7e5/docs/automation/CONTRACT.md)

В reviewer ZIP: `source-identity.json`, `reconstruction.json`, `reviewer-final.json`, `diagnostic-fixtures-only.patch`, `runner-identity-mapping.patch`, raw logs трёх разделённых наборов и `r31-boundary*`/`r31-*-oracle.json`.
