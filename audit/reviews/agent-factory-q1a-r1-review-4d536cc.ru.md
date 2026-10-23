# Проверка Q1A-R1: agent-factory на 4d536cc

Дата: 23 октября 2026, Europe/Amsterdam.

Проверенный `master`: **`4d536cc4917e3f6f468fe41a62e2cfb31718361c`**, `audit fixes 4`.
База предыдущего review: `66aea67b6cc32d3c5a91f1a1ebc600663035d779`.

**Вывод, уверенность 99%: Q1A-R1 принят частично. Переход к R2 пока не обоснован.** Прежние прямые ошибки исправлены, но появились воспроизводимые ошибки совместимости журнала с engine и небезопасное восстановление из старой копии. Это конкретные нарушения приёмки, а не требование обязательно запустить VM.

Следующий пакет — **Q1A-R1.1: согласовать запись/чтение журнала и завершить протокол recovery**. Промпт находится в `../copilot-q1a-r1-journal-recovery-fix.ru.md`.

## 1. Подтверждённые факты

Уверенность 100% в перечисленных локальных результатах, в пределах описанных fixtures.

- Приложенный отчёт побайтно совпадает с `../../docs/audits/remediation-q1a-r1-2026-10-23.md` в проверенном SHA. SHA-256: `9f3950a388093d0156c1b6c8c73a96fd57939fe5176334c998ab2c3b3aa5215b`.
- Между `66aea67` и `master` два коммита. `be640e5` добавляет предыдущий review и промпт; изменения реализации находятся в `4d536cc`. Поэтому указанная Copilot база `be640e5` не означает пропущенный промежуточный code pass.
- Общий diff: 9 файлов, +2375/−82. В самом remediation-коммите изменены 7 файлов. В списке отчёта не упомянут изменённый `../../setup/docs/troubleshooting.md`; это небольшая неточность отчётности.
- В отдельной рабочей копии на **Node v24.19.0** выполнены `npm ci`, typecheck и setup tests: **105 passed / 0 failed**, все команды завершились с кодом 0. Copilot сообщил Node v24.12.0; оба patch находятся в declared Node 24 range. Это не квалификация релизного toolchain или ОС.
- Дополнительно выполнены **6 положительных групп проверок, 10 отрицательных сценариев и отдельная проверка силы R1-03 test**. Положительная группа P06 содержит шесть отдельных, подтверждённо сработавших fault injections.
- Регрессия S00→S01 сравнена на обеих версиях: один и тот же сценарий получает `apply=0` на `66aea67` и `apply=8` на `4d536cc`.
- Исходники рабочей копии не изменялись. Для проверки теста R1-03 его compiled-копия изменялась только в памяти отдельного процесса; обычные 105 tests запускались без изменений.

Использованы временная FS и fake adapters. В N00 работают настоящие S00/S01 с подставными bootstrap/preflight evidence; в N01/N02 — настоящая S02 с fake AptAdapter и контролируемым S01 prerequisite. Реальные sudo, apt install, Docker daemon, OAuth/model/provider, systemd/SSH/firewall, GitHub writes и VM provisioning **NOT RUN**.

## 2. Что действительно исправлено

| Поведение | Результат review | Evidence |
|---|---|---|
| Read-only `status` на corrupt primary при удержанном lock | Primary сохранён; marker не записан; exit 8 | P01, repository R1-01/R1-02 |
| ENOSPC при записи marker | Исходное повреждённое evidence остаётся; следующие load не создают fresh state | P02 |
| Journal-only installation с валидным незавершённым intent | Fresh init запрещён; primary не создан | P03; checksum в нашем fixture настоящий |
| `recover` с marker и без пригодного candidate | Exit 8, marker сохранён; прежнего no-op success больше нет | P04 |
| Direct auth/smoke/inference-disable/backup-create при persisted in-flight | Все четыре команды получают 8 до process adapter; исходный intent сохранён | P05; apply использует тот же guard |
| Шесть отказов marker/quarantine | Каждый fault действительно сработал; два последующих writable load оставались blocked | P06 |
| `status --refresh` | Lock теперь берётся до potentially mutating load | `engine.ts:1039–1076` |
| EACCES/I/O в новых state readers | Код различает отсутствие и ошибки доступа вместо общего `exists=false` | `state.ts:118–158`; полная permission matrix отдельно не запускалась |

P06 проверяет marker write, file fsync, rename, directory fsync, quarantine rename и directory fsync после quarantine. Это логическая fault injection на временной FS, не физический power-loss test.

Эти изменения нужно сохранить. Проблема следующего шага — согласованность протокола целиком.

## 3. Подтверждённые дефекты

Ниже уверенность 100% в описанном наблюдаемом результате. P0 означает потерю защитного инварианта unknown/recovery; P1 — существенную поломку lifecycle/recovery; P2 — ограниченный дефект устойчивости/диагностики. Это не оценка вероятности эксплуатации злоумышленником.

### R1-F01 — P1, регрессия: engine создаёт журнал, который сам затем отвергает

**N00, N01, N02.** Новый reader требует receipt после intent с тем же ID, а producers не соблюдают этот формат:

- Настоящий S00 имеет пустой operations list, но `apply` возвращает `s00-bootstrap-check`. Engine пишет receipt без intent. На попытке дописать intent следующей S01 `readEvents` возвращает `journal_recovery_required`: **обычный S00→S01 apply получает 8**. На предыдущем SHA тот же probe получает 0.
- Для S02 install engine пишет intent только для первой операции — simulate. S02 возвращает receipt последней — install. **Apply получает 0, а следующие status/resume — 8**; simulate остаётся unresolved, install receipt отмечен unknown-order.
- Для уже установленных пакетов S02 возвращает `s02-noop` без operations/intent. **No-op также делает последующие status/resume неработоспособными**.

Это не только будущая проблема точности per-operation logging: сейчас сломан базовый положительный путь. В S03/S04 тоже есть no-op/last-operation receipts по исходникам, но отдельные executable probes для них здесь не запускались.

**Исправить:** согласовать producers и reader, различать наблюдения/no-op и эффекты, корректно учитывать каждую попытку. Нельзя просто перестать проверять журнал или принять любой orphan receipt. Нельзя объявить все операции завершёнными по одному stage success. Обязательны интеграционные tests с настоящими stage implementations.

Источники: [bootstrapStage](https://github.com/se-panfilov/agent-factory/blob/4d536cc4917e3f6f468fe41a62e2cfb31718361c/setup/src/core/engine.ts#L233), [apply intent/receipt](https://github.com/se-panfilov/agent-factory/blob/4d536cc4917e3f6f468fe41a62e2cfb31718361c/setup/src/core/engine.ts#L905), [journal reader](https://github.com/se-panfilov/agent-factory/blob/4d536cc4917e3f6f468fe41a62e2cfb31718361c/setup/src/core/state.ts#L454), [S02 receipts](https://github.com/se-panfilov/agent-factory/blob/4d536cc4917e3f6f468fe41a62e2cfb31718361c/setup/src/stages/system.ts#L322).

### R1-F02 — P0: старый receipt закрывает новую попытку; связи с checkpoint нет

**N03, N04, N05.** `inspectJournalEvidence` использует два глобальных Set по `operation_id`:

1. Валидный журнал `intent(X) → receipt(X) → intent(X)` считается полностью завершённым. `recover` возвращает `recovery_not_required / 0`. Последний intent относится к новой незавершённой попытке, но старый receipt закрывает его задним числом.
2. Валидные checksum при sequence `99 → 1` принимаются: `unknownOrder=false`, load успешен. Sequence фактически не валидируется. Сам checksum подтверждает только соответствие полей записи её checksum.
3. При старом checkpoint и более новых intent+receipt без verified completion/checkpoint `recover` также возвращает `recovery_not_required`. Между журналом и поколением state нет проверяемой связи.

N03/N05 моделируют восстановление с устаревшим checkpoint. Они не утверждают, что любой текущий обычный apply теряет `in_flight`: когда актуальное поле присутствует, новый guard правильно блокирует команду.

**Исправить:** отдельная идентичность попытки и проверяемый порядок событий; связь attempts, receipts, verification и committed checkpoint. Повторный ID операции не равен той же попытке. Legacy evidence без доказуемой связи остаётся unknown. Нельзя превращать audit history в разрешение на эффект.

Источник: [inspectJournalEvidence/readEvents](https://github.com/se-panfilov/agent-factory/blob/4d536cc4917e3f6f468fe41a62e2cfb31718361c/setup/src/core/state.ts#L454). R1-04/05/06; AF-05/06 остаются PARTIAL.

### R1-F03 — P0: recover разрешает откат к старому previous без доказательства безопасности

**N06.** Воспроизведена последовательность:

1. Сохранён чистый checkpoint, затем более новый state с `in_flight_operation=newer-unknown-effect`; previous остаётся чистым.
2. Новый primary повреждён обрывом JSON. Writable loader штатно пишет marker и переносит primary в quarantine.
3. Журнал отсутствует. `recover` принимает старый previous, возвращает 0, удаляет marker и восстанавливает `in_flight=null`.
4. Более новое quarantine evidence с идентификатором pending operation остаётся на диске, но **больше не блокирует обычную работу**.

Проверки installation/machine/path не доказывают, что snapshot является последним безопасным поколением. Отсутствие journal тоже этого не доказывает — особенно для старых данных и путей, которые ещё не записывают полный протокол. Recovery не анализирует доступное newer evidence и не доказывает отсутствие неизвестного эффекта.

**Логическое последствие, уверенность 97%:** такая очистка active uncertainty может разрешить повтор внешнего действия. Реальный повтор apt/model/OAuth в probe не выполнялся; весь forensic-файл не удалён.

**Исправить:** принимать candidate только при доказуемой непрерывности поколений и отсутствии более новой неопределённой операции. Corrupt newer state с неизвестным содержимым по умолчанию не является доказательством безопасного rollback. Неизвестное возвращает 8, сохраняя barrier. Нужен хотя бы один действительно доказуемый положительный recovery case, а не глобальный запрет всего восстановления.

Источник: [runRecover: candidate selection](https://github.com/se-panfilov/agent-factory/blob/4d536cc4917e3f6f468fe41a62e2cfb31718361c/setup/src/core/engine.ts#L1336). R1-06/07/08/09.

### R1-F04 — P1: interrupted recovery портит собственный fallback

**N07.** Два последовательных injected I/O failures в разрешённых fault windows:

1. Marker уже persisted, но quarantine rename падает; primary остаётся corrupt, previous валиден.
2. `recover` вызывает обычный `saveState(candidate)`. Новый primary записан правильно, но старый corrupt primary скопирован поверх пригодного previous.
3. Удаление marker падает. Первый recover получает `recovery_marker_clear_failed`.
4. Повторный recover читает теперь повреждённый previous и получает `recovery_candidate_invalid / 8`, хотя восстановленный primary валиден.

Это потеря пригодного fallback и неидемпотентное продолжение recovery, а не доказанная потеря всех копий данных.

**Исправить:** recovery commit должен сохранять проверенный candidate и durable decision до завершения. Не использовать обычную ротацию previous без учёта повреждённого primary. После каждого interrupted boundary повторная команда должна продолжить доказанный commit либо честно сохранить unknown; нельзя требовать ручного удаления marker для обхода ошибки.

Источники: [saveState](https://github.com/se-panfilov/agent-factory/blob/4d536cc4917e3f6f468fe41a62e2cfb31718361c/setup/src/core/state.ts#L321), [recovery commit](https://github.com/se-panfilov/agent-factory/blob/4d536cc4917e3f6f468fe41a62e2cfb31718361c/setup/src/core/engine.ts#L1376). R1-04/08/11.

### R1-F05 — P2: stat перед readFile не ограничивает фактический объём чтения

**N09.** Между stat и read journal в fixture увеличен с 0 до 2 MiB. Reader прочитал все 2 MiB при declared limit 1 MiB и вернул `oversized=false`. Подставлен только момент изменения файла; использован настоящий filesystem read.

В обычном oversized-файле stat guard работает. Ошибка относится к конкурентному изменению/подмене между проверкой и чтением. Probe не является утверждением о remote DoS.

**Исправить:** ограничить чтение по фактически полученным bytes, желательно через один открытый descriptor с bounded read/stream. Проверка длины после полного read исправит флаг, но не ограничение памяти. То же правило должно использоваться при повторном чтении в `readEvents`.

Источник: [journal size/read](https://github.com/se-panfilov/agent-factory/blob/4d536cc4917e3f6f468fe41a62e2cfb31718361c/setup/src/core/state.ts#L418). R1-05.

### R1-F06 — P2: marker `null` вызывает untyped exception

**N08.** `recovery-required.json` с валидным JSON `null` приводит к `unexpected_error / exit 6` и сообщению `Cannot read properties of null...`. Вместо typed recovery diagnosis происходит TypeError.

Эффект не разрешается, read-only запись не появляется: это ошибка диагностики и полноты schema validation, не обход guard.

**Исправить:** проверять тип объекта до доступа к полям; null/array/scalar/malformed input должны давать typed, безопасный recovery outcome. Прогнать аналогичные границы record parsing, не полагаясь на TypeScript cast.

Источник: [readRecoveryMarker](https://github.com/se-panfilov/agent-factory/blob/4d536cc4917e3f6f468fe41a62e2cfb31718361c/setup/src/core/state.ts#L364). R1-02.

### R1-F07 — P1 для приёмки: часть PASS не проверяет заявленный invariant

**Отдельный test-quality probe.** У compiled R1-03 заменён только конструктор `InstrumentedFilesystemAdapter([boundary.rule])` на вариант без rules. Все исходные assertions сохранены. Test **по-прежнему проходит**, хотя ни один из шести заявленных отказов не инъецируется. Причина: обычная corruption без injected failure уже даёт ожидаемые exit 8/evidence.

Это не доказательство, что реальные injections исходной suite не срабатывают. Это доказательство, что test не замечает их отсутствие. В нашем P06 срабатывание каждого fault проверено отдельно, и текущий код выдержал эти шесть сценариев.

Другие ограничения покрытия:

- R1-02 содержит четыре damaged fixtures; полный обещанный EACCES/config-drift matrix не реализован в этом test.
- R1-05 с названием journal-only/torn/oversized фактически проверяет один oversized payload.
- R1-06 использует заведомо неверный checksum, поэтому его отказ не доказывает правильную обработку валидного незавершённого intent.
- R1-04 повторно использует одну директорию и не восстанавливает исходную пару current/previous перед каждым boundary; после успешного commit последующие saves могут писать тот же state. Interrupted `recover` не покрыт.
- R1-11 действительно использует отдельный процесс, но он лишь удерживает lock. Полноценные конкурирующие write/recovery transitions и interrupted recovery этим не доказаны.
- R1-12 не проходит настоящий lifecycle S00→S01/S02; N00/N01/N02 показывают, почему это существенно.

**Исправить:** test обязан проверять факт и место отказа, переход состояний и отсутствие нежелательного эффекта. Fault disabled → fault-specific assertion должна падать. Для каждого boundary — чистый fixture, известные поколения и проверяемый durable результат.

Источник: [R1 tests](https://github.com/se-panfilov/agent-factory/blob/4d536cc4917e3f6f468fe41a62e2cfb31718361c/setup/tests/integration/core-q1a-r1-state-recovery.test.ts#L553).

## 4. Пересмотр приёмки R1

PASS ограничен указанным scope. FAIL означает воспроизведённый контрпример, PARTIAL — полезное покрытие без полного заявленного свойства.

| Критерий | Review | Обоснование |
|---|---|---|
| R1-01 | PASS в проверенном scope | Valid status/gate-list и held-lock read-only controls работают |
| R1-02 | PARTIAL | Основные non-mutating branches исправлены; null marker даёт untyped error; полный error matrix не покрыт |
| R1-03 | PASS для шести injected boundaries | Наш P06 проверяет hit каждого fault и повторные writable load; repository test нужно усилить |
| R1-04 | PARTIAL | Обычные save boundaries проверены ограниченно; связь commit/journal и interrupted recovery сломаны |
| R1-05 | FAIL полного критерия | Простые orphan/oversize блокируются; attempts/order/bounded read неполны |
| R1-06 | FAIL | N03/N05/N06: stale checkpoint и newer uncertainty не учитываются надёжно |
| R1-07 | PARTIAL | No-candidate case честно blocked; наличие старого candidate может ошибочно снять barrier |
| R1-08 | PARTIAL | Happy-path restore проходит; доказательство безопасности и retry после сбоя отсутствуют |
| R1-09 | PARTIAL | Installation/machine checks полезны; matching identity не доказывает пригодность поколения |
| R1-10 | PASS для persisted in-flight в рассмотренных routes | Shared guard работает; ложная очистка uncertainty раньше guard остаётся F02/F03 |
| R1-11 | PARTIAL | Reader vs held lock проверен отдельным процессом; concurrent commit/recovery matrix не выполнена |
| R1-12 | FAIL | Реальные S00→S01 и S02 нарушают положительный lifecycle |

Итого: матрицу «все R1 PASS» нельзя использовать как основание перехода. A08/A10/A11 и AF-05/06 также нельзя повышать до полного PASS по этому отчёту.

## 5. Логические выводы и порядок работы

**Уверенность 99%:** R1 ещё не завершён. Причина — реальные контрпримеры, хотя большинство прежних прямых ошибок устранено.

**Рекомендация, уверенность 97%:** выполнить один согласованный пакет R1.1 по приложенному промпту:

1. Согласовать attempts, journal producers/reader и checkpoint binding. Включить необходимые минимальные изменения engine/stages; заранее проверить настоящие S00/S01/S02 install/no-op paths.
2. Запретить недоказанный rollback и сделать recovery commit возобновляемым без уничтожения candidate.
3. Исправить bounded read/schema errors и усилить fault/concurrency tests.
4. После отдельного review перейти к R2. В R3 оставить ещё не выполненные per-effect cancel/gate checks и остальные execution guarantees; Q1B — process supervision/cleanup. Затем прежние Q2–Q6.

Разделение R1 и R3 в моём прежнем плане оказалось слишком жёстким: новый reader зависит от реального формата событий, а их запись осталась старой. Исправлять только reader при несовместимых producers было нельзя. Это уточнение границы работ, не предложение откатить read-only guards или отключить журнал.

### Что из предыдущего review остаётся открытым

Q1A-F04 (bulk stage effects, cancel/expiry внутри stage), F05 (полный fresh binding), оставшаяся F06 (truthful auth/live outcomes), F07 (S08 prerequisites), F08 (awaiting_manual aggregation), F09 (sanitization) не закрываются этим pass. Неизменённые Q2–Q5 security components полностью заново не аудировались. Текущий review не выдаёт допуска на реальные sudo/credentials/production paths.

### Действия владельца

1. Передать Copilot этот review и `../copilot-q1a-r1-journal-recovery-fix.ru.md`; архив приложить для воспроизведения. Новая работа — в отдельной ветке от актуального master.
2. После выполнения получить SHA, diff и отчёт с результатами acceptance; прислать для review перед следующим слиянием. Уже merged историю переписывать не нужно.
3. VM, GitHub integration и настоящие tokens для R1.1 не нужны. Не удалять state/marker/quarantine/journal вручную ради обхода обнаруженных blockers.

## 6. Ограничения и самопроверка

Все отрицательные probes намеренно assert поведение ошибочной версии: их exit 0 означает успешное воспроизведение дефекта, а не PASS продукта. Архив содержит код, JSONL, before/after и полные логи.

Неизвестны реальные power-loss semantics конкретной FS, поведение sudo/ОС/provider и срок завершения remediation. Они не подменены результатами mocks. При пересмотре R1.1 ключевое улучшение проверки — начинать с короткого настоящего lifecycle, затем переходить к отдельным fault cases: это раньше выявит несовместимость модулей.
