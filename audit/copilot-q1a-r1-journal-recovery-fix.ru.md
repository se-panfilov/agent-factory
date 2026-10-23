# Copilot: Q1A-R1.1 — согласовать journal/checkpoint и завершить recovery

Передай этот промпт целиком вместе с `reviews/agent-factory-q1a-r1-review-4d536cc.ru.md`. Для воспроизведения приложи `agent-factory-q1a-r1-evidence-4d536cc.zip`.

---

Выполни законченный remediation-пакет **Q1A-R1.1** в `se-panfilov/agent-factory`. Проверенная база: `4d536cc4917e3f6f468fe41a62e2cfb31718361c`, 105 setup tests проходят на Node 24.19.0. R1 принят частично: предыдущие прямые ошибки исправлены, но R1-F01…F07 из нового review остаются открытыми.

**Цель:** совместимые journal producers/reader, сохранение неизвестных операций при recovery и возобновляемый recovery commit. Восстановить положительный lifecycle настоящих S00/S01/S02. Не переходить к R2/Q1B и не объявлять весь Q1A/AF-05/06 закрытым.

## 1. Scope и ограничения

1. Проверь branch, HEAD, dirty tree. Если master новее проверенного SHA, изучи diff и повтори probes на актуальном коде. Работай в отдельной ветке `fix/q1a-r1-journal-recovery`, если нет подходящей. Не reset чужие изменения, не переписывай merged историю; не merge/publish/deploy.
2. Прочитай `AGENTS.md`, `docs/automation/CONTRACT.md` C03/C06/C07/C08/C09, `audit/copilot-q1a-r1-state-recovery.ru.md`, предыдущие review в `audit/reviews/`, `docs/audits/remediation-q1a-r1-2026-10-23.md`, новый review. Если нового review ещё нет в repo, добавь его в `audit/reviews/`.
3. Разрешены согласованные изменения state/journal/recovery, engine, filesystem abstraction, необходимых внутренних types и **минимальные изменения producers/stages для совместимости протокола**, tests и docs. Этот cross-cutting scope явно разрешён; прежнее «один Pxx» ему не препятствует.
4. Public contract/CLI/state schemas сохраняются. Новая внутренняя metadata допустима с versioning, strict validation и определённым поведением для legacy. Нельзя молча менять нормативный смысл, расширять public schema через `as any` или объявлять старые данные доказательством новых гарантий.
5. Сохрани успешные исправления R1: read-only non-mutation; строгие I/O errors; marker до quarantine; shared in-flight admission; lock до status refresh; safe cancel request; существующий запрет public restore/update.
6. Только temp FS, injected process/network/apt adapters и локальные Node subprocesses. **Никаких реальных sudo/apt/systemd/SSH/firewall/Docker daemon/OAuth/model/GitHub writes.** Не менять credentials/состояние настоящих установок. Не добавлять публичный env/CLI bypass ради тестов.

Полный process-tree supervisor, все live gates и per-effect cancel остаются позже. Но формат записей producer и reader нельзя оставлять несовместимым под предлогом R3. Если для корректного журнала нужна часть execution protocol, реализуй именно необходимую часть сейчас и точно опиши оставшуюся границу.

## 2. Сначала воспроизведи подтверждённые дефекты

Используй приложенные probes; они намеренно assert плохое поведение исходной версии. Их зелёный результат — воспроизведение bug, не regression PASS исправленного кода.

| Случай | Наблюдение на 4d536cc |
|---|---|
| Настоящие S00→S01, fake bootstrap/host evidence | Plan 0, apply 8: S00 receipt без intent блокирует S01 |
| Настоящая S02 install с fake apt | Apply 0, status/resume 8: intent simulate и receipt install не образуют пару |
| Настоящая S02 no-op | Apply 0, status/resume 8: orphan `s02-noop` receipt |
| Валидные `intent(X), receipt(X), intent(X)` и старый checkpoint | Reader считает всё завершённым; recover 0 |
| Valid checksums, sequence 99→1 | Принимается как известный порядок |
| Receipt после старого checkpoint без verified completion | Recover 0 вместо сохранения uncertainty |
| Corrupt newer state с in-flight, clean previous, пустой journal | Recover откатывается к previous и снимает barrier |
| Quarantine rename failure, затем marker-remove failure при recover | Пригодный previous заменён corrupt bytes; retry не может восстановиться |
| Marker `null` | TypeError / exit 6 вместо typed recovery diagnosis |
| Journal растёт между stat/read | Чтение превышает лимит; oversized=false |

Отдельно повтори test-quality probe: R1-03 остаётся PASS при отключении всех шести его failure rules. Исходную обычную suite не модифицируй ради отчёта. Сравнение делается в отдельном процессе/копии.

## 3. Один протокол: попытка → effect evidence → verification → checkpoint

До реализации кратко опиши таблицу durable states и переходов. Затем реализуй её. Нужен минимальный совместимый протокол, не универсальная workflow platform.

- **Operation ID и attempt ID различаются.** Повторный план или повтор той же операции не должен наследовать terminal receipt старой попытки. У каждой записи должна быть проверяемая принадлежность нужной попытке/поколению/installation в рамках выбранного внутреннего формата.
- **Порядок проверяется.** Sequence, checksum, обязательные типы, operation/stage identity и допустимые transitions валидируются. Duplicate/gap/reorder/receipt-before-intent и неизвестный формат не считаются успешным завершением. Если протокол допускает какую-либо повторную запись, её идемпотентность должна быть явно определена и протестирована.
- **Receipt не равен verified checkpoint.** Между side-effect receipt, проверкой postconditions и committed state нужна проверяемая связь. Старый state и более новые events нельзя объявлять согласованными только потому, что каждый operation ID встречается в обоих Set.
- **Journal history не выдаёт разрешение.** Current admission опирается на согласованное durable состояние и fresh checks. Старый audit receipt не авторизует новую попытку. Неизвестное после crash требует reconciliation; автоматический replay запрещён.
- **Intent до соответствующего эффекта; receipt после него.** Не придумывай receipt и не закрывай неподтверждённую operation только по stage success. Не выдавай запись всех плановых intents заранее за доказательство per-operation execution.
- **Producers и reader меняются вместе.** Проверь все места, возвращающие no-op, first-operation или last-operation receipts. Нужны реальные S00/S01/S02 tests. Соседние stages не должны оставаться заведомо несовместимыми с новым reader; их опасные неподдержанные пути блокируются до эффекта с точной причиной.
- **No-op — отдельный понятный случай.** При пустом плане и свежих подтверждённых prerequisites используй безопасные observe/verify. Не вызывай effectful apply только ради искусственного receipt. Не принимай произвольный unplanned mutation receipt под видом no-op. Не снимай blanket запрет S08 effects; его более широкая dependency policy остаётся R2.
- **Legacy:** старые IDs/records могут не позволять отличить попытки или доказать completion. Такие случаи остаются unknown либо проходят отдельную доказуемую read-only reconciliation. Нельзя очищать старый журнал, marker или inflight ради перехода на новый формат.

При необходимости добавь versioned внутренний ledger/commit metadata, сохранив public schemas. Конкретную реализацию выбери самостоятельно, но опиши commit point и последствия каждой прерванной записи.

## 4. Recovery не должен терять неопределённость

- Matching installation/machine/path — необходимые checks, **но не доказательство безопасного поколения**. Учитывай доступные primary, previous, quarantine, journal, recovery metadata и связь их поколений. Отсутствие journal не доказывает отсутствия эффекта у legacy installation.
- Если primary/quarantine может содержать более новое неизвестное действие, старый clean previous не разрешает снять barrier. Возвращай 8 с конкретным evidence/next action; не инициируй повтор внешнего действия.
- Сохраняй проверенный candidate до окончания recovery transaction. Не копируй corrupt primary поверх последнего пригодного previous обычным `saveState` без recovery-aware protocol.
- Durable recovery decision должна позволять отличить «commit ещё не произошёл» от «primary уже восстановлен, cleanup marker не завершён». После сбоя повторный recover либо безопасно продолжает доказанную транзакцию, либо оставляет unknown.
- Проверь отказ до/после записи decision, candidate, primary, previous, rename/fsync и очистки marker. Отказ cleanup не должен превращаться ни в ложный completed, ни в потерю единственного fallback.
- Reader остаётся чистым на всех этих промежуточных состояниях. Repair/quarantine/cleanup выполняются только сериализованным writer/recovery path.
- Сохрани три честных исхода: no recovery needed; доказуемое выполненное recovery; unresolved/exit 8. Положительный supported case обязан быть доказуем протоколом. Просто всегда возвращать 8 не считается реализацией recovery.
- `recover --lock-only` по-прежнему управляет только lock и показывает оставшиеся blockers. Он не снимает state uncertainty и не заявляет readiness.

Настоящие apt/Docker/provider reconcilers в этом пакете не требуются. Их unknown effects остаются blocked, пока нет доказанного результата.

## 5. Bounded readers и validation

- Лимит journal должен ограничивать **фактически прочитанные bytes**, включая рост между stat/read. Используй bounded descriptor/stream read; постфактум `raw.length` после неограниченного readFile недостаточно.
- Устрани повторное неограниченное чтение в `readEvents`. Определи результат конкурентного append и оборванного последнего record; никаких скрытых repair writes из read-only loader.
- Проверяй object/null/array/scalar и поля marker/event до доступа к ним. Повреждённый control artifact получает typed recovery error, а не raw TypeError. Не печатай сырой secret-bearing content в public errors.
- Различай ENOENT, EACCES и I/O failures. Fresh detection не должна ослабнуть из-за ошибок нового parser.
- Нельзя молча обрезать или удалять history ради лимита. Если поддерживаемый формат требует compaction/rotation, сохраняй continuity и audit evidence; иначе явно фиксируй ограничение и безопасное blocked поведение.

## 6. Обязательная приёмка R1.1

Все tests — реальные core/stage functions, temp filesystem, injected adapters. Fake apt/host разрешён; подмена всей проблемной stage на тривиальную fake stage не доказывает исправление.

| ID | Проверка | Требуемый результат |
|---|---|---|
| J01 | Настоящие S00→S01: plan→apply→status→resume, включая новый процесс | Нет self-generated journal error; наблюдения не превращаются в unpaired mutation receipts |
| J02 | Настоящая S02: install, metadata refresh + install, затем no-op/repeat | Все фактические operations учтены; status/resume работают; no-op не вызывает install/не портит journal |
| J03 | Повтор operation ID, новая attempt; duplicate/gap/reorder/stage mismatch; receipt-before-intent | Старый receipt не закрывает новую attempt; некорректный порядок даёт typed recovery outcome |
| J04 | Effect receipt без verification/checkpoint; stale current/previous; crash до/после commit | Unknown не completed; нет автоматического replay; commit определяется по протоколу |
| J05 | Newer corrupt/quarantine in-flight + old clean previous + пустой journal; marker с более новым current | Нельзя убрать uncertainty на основании одного matching previous; effects не вызваны |
| J06 | Interrupted recovery на каждом durable boundary, включая N07 | Пригодный candidate сохранён; повтор не застревает из-за собственной перезаписи previous и не теряет unknown |
| J07 | Действительно доказуемый safe recovery и повтор recover после commit/cleanup failure | Корректное восстановление и идемпотентное продолжение; не глобальный запрет installer |
| J08 | Null/array/scalar/malformed marker/record; oversized и concurrent journal growth; EACCES | Typed errors, ограниченное фактическое чтение, нет secret dump или hidden writes |
| J09 | Fault-specific tests и отрицательная проверка самих injections | Проверены hit/count/boundary; при выключенном ожидаемом fault test падает; каждый case начинает с чистого fixture |
| J10 | Pending state/journal/marker + effectful entrypoints; read-only/cancel controls | Нет ordinary effect до reconciliation; reads не пишут; cancel остаётся доступен при damaged state |
| J11 | Отдельные процессы: writer на контролируемой границе, reader и full recover; interruption/restart | Чужой lock не захватывается; readers не чинят; нет lost update/необоснованного reset |
| J12 | Существующая suite + новые acceptance tests на Node 24 | Никакого удаления проверок ради green; изменения старых ожиданий обоснованы контрактом |

J11 координируй через IPC/barriers, а не arbitrary sleeps. Сценарий, где child лишь держит lock, сохраняй как полезный control, но не называй полным writer/recovery race test.

Для J06/J09 выдай таблицу **фактически** инъецированных boundaries: состояние до отказа, fault hit, durable evidence после, результат повторной команды. Восстанавливай независимый исходный fixture перед каждым boundary. Ошибка от исходной corruption не заменяет доказательство injected I/O failure.

Используй безопасные synthetic secrets и bounded test data. Все real host/live paths — NOT RUN.

## 7. Команды и результат

На поддерживаемом **Node 24**:

```bash
npm --prefix setup ci --ignore-scripts --no-audit --no-fund
npm --prefix setup run typecheck --silent
npm --prefix setup run test --silent
```

Покажи failing-before/passing-after для N00/N01/N02/N03/N06/N07. Если regression test использует новое API, старое поведение фиксируется отдельным probe на исходном SHA; не выдумывай red run некомпилирующегося теста.

Добавь `docs/audits/remediation-q1a-r1-1-2026-10-23.md` с фактической датой выполнения, baseline, идентичностью проверенного code/test tree, изменёнными файлами, протоколом и ограничениями, J01…J12, командами/Node/exit codes, NOT RUN. Не выдавай pre-edit SHA за SHA исправленного и протестированного кода: укажи code commit либо tree hash и состояние незакоммиченных изменений.

Обнови `setup/docs/privileges.md`, troubleshooting и relevant state docs только по реализованному поведению. Исправь безусловные заявления о per-effect checks: полный cancel/gate/process cleanup этим pass не закрывается.

В старых R1/A/AF matrices сохрани историю и добавь точный superseding результат. Не переписывай прошлый отчёт так, будто весь новый результат был уже доказан тогда. Финальный ответ: что исправлено, evidence по каждому J, что осталось unknown/blocked и готовность к отдельному review.

Заверши пакет целиком. Если есть реальный contract/input blocker, назови точный конфликт и продолжай независимую часть. Routine choices решай самостоятельно. **Не переходи автоматически к R2/Q1B и не выдавай production admission.**
