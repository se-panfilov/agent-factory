# Copilot: Q1A-R1 — завершить state/recovery без потери evidence

Скопируй промпт целиком. Передай вместе с ним `reviews/agent-factory-q1a-review-66aea67.ru.md` и, при необходимости, архив probes.

---

Выполни один законченный пакет **Q1A-R1: state/recovery safety** в `se-panfilov/agent-factory`. Исходная проверенная версия — `66aea67b6cc32d3c5a91f1a1ebc600663035d779`, 93 setup tests проходят на Node 24.19.0. Q1A в целом ещё не принят.

Этот пакет исправляет Q1A-F01/F02/F03 и общую state admission часть F06 из нового review. **Не переходи к Q1B и не пытайся закрыть остальные AF заодно.** Нужны рабочий код, fault-injection tests и точный отчёт.

## 1. Рабочая область

1. Проверь branch, HEAD и dirty tree. Не откатывай и не переписывай merged master. Если код новее исходного SHA, сначала изучи diff и проверь актуальность finding. Создай отдельную ветку `fix/q1a-r1-recovery`, если нет подходящей рабочей ветки. Не merge/publish/deploy.
2. Прочитай `../AGENTS.md`, `docs/automation/CONTRACT.md` C02/C03/C04/C07/C08/C09/C10, `audit/reviews/agent-factory-audit.ru.md`, `audit/reviews/agent-factory-production-review-eb187a8.ru.md`, `docs/audits/remediation-q1a-2026-10-23.md`, `setup/docs/privileges.md` и новый review. Если новый review только во вложении, сохрани его в `audit/reviews/`.
3. Разрешены согласованные изменения `../setup/src/core/state.ts`, callers в engine, необходимого filesystem/lock integration, schemas только в совместимых пределах, tests и docs. Cross-cutting изменения внутри этого remediation явно разрешены; старое ограничение «один Pxx» не мешает этому пакету.
4. Сохрани предыдущие исправления: явный config, strict CLI, expiry rejection, ordinary-writer locks, запрет public restore/update и no-primary-delete atomic save. Не снимай guards, чтобы пройти tests.
5. Состояние/журнал/marker — доверенная control-plane информация обычного owner; они не являются защитой от hostile same UID. Не объявляй checksum авторизацией.
6. No real sudo/apt/systemd/SSH/firewall/Docker daemon/OAuth/model/GitHub writes. Только temp FS, injected adapters, локальные Node subprocesses. Не изменять пользовательские credentials, конфиги ОС или реальные установки.

## 2. Сначала воспроизведи четыре конкретные ошибки

| Сценарий | Поведение на 66aea67, которое должно измениться |
|---|---|
| Удержан installation lock, primary corrupt; вызвать `status` без refresh | Primary переименован и marker записан вне lock |
| Primary corrupt без previous; ENOSPC при записи recovery marker после quarantine rename; повторить load | Создаётся fresh state, старое uncertainty исчезает |
| State/previous/marker отсутствуют, journal содержит незавершённый intent | Создаётся fresh state |
| Marker существует; выполнить обычный `recover` | Exit 0 / ok, хотя marker не устранён и recovery не выполнен |

Дополнительно: direct `auth login` в текущем коде вызывает adapter при существующем `in_flight_operation`. В R1 такое обычное effectful действие должно блокироваться **до** adapter call; исправление полного OAuth/postcondition protocol оставь R2/Q4.

Probes из review намеренно assert ошибочное поведение. Не копируй их assertions как новую зелёную regression suite: tests исправленного кода должны проверять безопасный результат.

## 3. Read-only действительно ничего не пишет

- Раздели загрузку/валидацию snapshot, initialization, quarantine и recovery. Флаг readOnly не должен оставлять скрытые mutating branches.
- `status` без refresh, `gate list`, read-only часть blocked entrypoints и диагностическое чтение cancel/recover не вызывают write/append/rename/remove/fsync-for-write/mkdir на любых damaged/missing/schema/drift paths.
- На повреждённом state reader возвращает typed diagnostic/recovery-required. Он не создаёт recovery marker и не перемещает файлы, даже если это кажется полезной починкой.
- `status --refresh` получает lock **до** любых потенциально пишущих действий. Нельзя сначала вызвать mutating loader, а потом взять lock.
- Учитывай normal valid state, corrupt primary, missing primary + previous, invalid previous, existing marker, journal-only, config drift, permission/I/O failure. При read-only проверяй не только итоговый file content, но и отсутствие mutating FS calls.
- Не скрывай ошибки чтения как «файл отсутствует». Для control state различай ENOENT, EACCES и I/O failure там, где решение об initialization/recovery зависит от этого.

## 4. Crash-consistent recovery protocol

До реализации определи в коде/docs последовательность операций и допустимые durable states. Выбери минимальную совместимую реализацию; не создавай универсальную workflow platform.

- **Fresh install:** отсутствие primary само по себе недостаточно. Учитывай предыдущие generations, quarantine, nonempty/corrupt journal и operation evidence. Артефакты старой установки должны приводить к recovery-required, а не к default state с null inflight.
- **Corruption:** не убирай последний известный evidence до появления durable способа распознать interrupted recovery. Если создание marker не удалось, последующий обычный load всё равно обязан распознать damaged existing installation. Просто перенести запись marker выше rename недостаточно без проверки всех последующих failure windows.
- **Current/previous:** не возвращать прежнюю копию как доказательство отсутствия более поздних effects. Candidate проверяется до записи в primary: schema, доступная достоверная installation/host identity, generation/journal continuity. Не принимать общий fallback machine identity как настоящий host fingerprint.
- **Journal:** незавершённый intent, receipt без согласованного completion, torn/corrupt record или неизвестный порядок остаются uncertainty. Нельзя обнулить usage/inflight/history ради восстановления JSON. Разбор повреждённого/слишком большого journal должен быть bounded и fail-closed.
- **Durability:** опиши и проверь write/fsync/rename/fsync-dir boundaries для primary, previous, marker и journal. Сбой после commit primary, но до обновления previous имеет однозначный recovery outcome; не объявляй, что effect/commit не произошло только потому, что последующий шаг упал.
- **Legacy data:** текущие старые state/journal нельзя молча интерпретировать как новые guarantees. Если достоверного решения о committed/unknown нет, сохраняй blocking diagnosis и evidence. Не делай destructive migration или incompatible public schema change без ADR/versioning.
- **New internal metadata:** допустимо, если совместимо с нормативным контрактом и имеет явную version/validation strategy. Не ослабляй strict schema и не прячь ошибки через `as any`.

Приёмка — отсутствие потери uncertainty и повторного dangerous effect, а не просто наличие файла с названием `recovery-required.json`.

## 5. Честный recover

Раздели три исхода:

1. **Recovery не требуется:** согласованный state, нет незавершённых effects; допустим безопасный no-op outcome, явно объясняющий scope.
2. **Восстановление доказуемо:** восстанови только проверенный snapshot/metadata под lock, с durable decision/evidence; снимай barrier лишь после подтверждённого commit. Например, поддерживаемая безопасная recovery generation без возможного внешнего незавершённого effect должна иметь положительный regression test.
3. **Исход неизвестен или нет реализованного reconciler:** exit 8, конкретная причина/operation/evidence и безопасный next action. Ничего не удалять и не повторять автоматически. Не возвращать ok с фразой «recovery не реализован».

Не требуется в R1 реализовывать настоящую reconciliation apt/Docker/provider: эти cases должны честно оставаться blocked. Нельзя подменять её очисткой inflight или marker. Если восстановление конкретного старого snapshot невозможно доказать, это допустимый fail-closed результат, но не PASS восстановления.

`recover --lock-only` управляет только lock. Успех этой узкой операции не очищает state barrier и не означает readiness установки. Покажи remaining recovery blockers отдельно. Не удалять активный/чужой/неопределённый lock; не превращать missing owner в автоматическое разрешение продолжить.

## 6. Общий state admission для entrypoints

Один shared helper/policy должен проверять unresolved recovery/in-flight/journal state перед ordinary effects. Вызов `loadState` под lock сам по себе не является этой проверкой.

- Классифицируй каждый public command: read-only snapshot; serialized observation update; ordinary effect; cancellation/emergency; recovery. Не оставляй обход через отдельные auth/smoke/backup/inference routes.
- Пока есть unresolved effect, новая ordinary mutation отклоняется до process/HTTP/provider/resource adapter call. При этом не стирается исходная ошибка/operation evidence.
- Чтение и безопасная диагностика разрешены без объявления verified. Diagnostic persistence, если оно необходимо, имеет явный protocol и не стирает uncertainty.
- Cancel/emergency/recovery — ограниченные исключения с определённой целью; они не ждут lock того действия, которое должны остановить. Сохрани возможность запросить cancel при damaged state. Сам запрос cancel не является разрешением reset.
- Не включай OAuth/live/restore/update ради теста. Existing public restore/update containment сохраняется. Fake adapters инъецируются программно в tests; не добавляй публичные env/CLI switches для обхода admission.

R1 не закрывает полную freshness/plan binding и per-operation execution: это R2/R3. Не объявляй их сделанными в отчёте из-за появления этого helper.

## 7. Приёмка R1

Каждый тест проверяет конечный invariant и evidence. Используй реальный loader/engine и temp filesystem. Для отказов — fault injection до/после конкретных operations; для межпроцессных гарантий — отдельные Node processes с детерминированным coordination, без arbitrary sleeps как доказательства.

| ID | Проверка | Ожидаемый результат |
|---|---|---|
| R1-01 | Валидный state: status/gate list, в том числе при held writer lock | Согласованное чтение, ноль FS mutations; правильная recorded metadata |
| R1-02 | Read-only load corrupt/missing/previous/marker/journal-only/config drift/EACCES | Ноль write/rename/remove; явный typed diagnosis; нет скрытого init/quarantine |
| R1-03 | Corrupt primary без previous, failure при marker write/fsync/rename/dir fsync, повторные commands | Никогда fresh reset; повреждённое evidence и uncertainty сохранены |
| R1-04 | Отказы на каждой границе save current/previous/journal | Определённый committed/recovery state; последний валидный snapshot не потерян; unknown не становится completed |
| R1-05 | Непарный intent без primary/previous/marker; corrupt/torn journal | Recovery-required, bounded parsing, нет initialization |
| R1-06 | Старый previous до последнего intent; effect случился, receipt не записан | Нет автоматического replay; unknown сохраняется после нескольких load/resume/recover |
| R1-07 | Marker/inflight есть, обычный recover не может доказать resolution | Exit 8; evidence/marker не очищены; next action не советует их удалить |
| R1-08 | Доказуемое supported восстановление без неизвестного внешнего effect | Recovery действительно восстанавливает согласованное состояние; повторный recover идемпотентен |
| R1-09 | Невалидный/чужой recovery candidate и missing/invalid host identity | Refusal до перезаписи primary; forensic evidence сохранено |
| R1-10 | Pending effect + каждый ordinary effectful route | Нет process/provider/resource call, в частности fake Docker login не вызывается; исходный intent сохранён |
| R1-11 | Конкурирующие writer и readers/recover; status refresh до lock; interrupted recovery | Readers ничего не чинят; recovery не захватывает чужую транзакцию; нет lost updates/reset |
| R1-12 | Clean fresh installation, valid save/load, normal corruption, cancel request, lock-only recovery | Positive controls работают; запретить весь installer не считается исправлением |

Для R1-03/04 перечисли реально инъецированные boundaries и результат каждой. Не пиши «full fault matrix PASS» по одному ENOSPC test. Для R1-11 хотя бы критический writer-vs-reader/recover сценарий должен быть проверен отдельными процессами, а не только двумя объектами engine в одном процессе.

Запускай проверки на **Node 24** согласно package engines. Node 26 не является заменой required runtime. Используй доступный toolchain/version manager; если Node 24 действительно недоступен, продолжай независимую реализацию, но честно укажи этот test blocker.

```bash
npm --prefix setup ci --ignore-scripts --no-audit --no-fund
npm --prefix setup run typecheck --silent
npm --prefix setup run test --silent
```

Покажи failing-before/passing-after для воспроизводимых старых bugs. Если новый тест требует нового API, зафиксируй старое поведение отдельным probe, а не выдуманным red run. Не заменяй meaningful assertions snapshot текста новых error messages.

## 8. Результат и граница завершения

- Добавь `docs/audits/remediation-q1a-r1-2026-10-23.md`: baseline и фактически проверенный source SHA/tree, точный scope, протокол commit/recovery, R1-01…R1-12 с evidence, команды/Node version/exit codes, NOT RUN, нерешённые случаи.
- Обнови `../setup/docs/privileges.md` и state/recovery docs только в части фактически реализованного. Исправь утверждения о read-only и recovery. Укажи, что per-operation effects/process cleanup/полный gate binding всё ещё R2/R3/Q1B.
- В A01…A16/AF matrix отмечай закрытие конкретных подпунктов. Не объявляй AF-05/06 или весь Q1A закрытым только по PASS R1. Список остальных findings из review остаётся открытым.
- Итог: изменённые security-sensitive файлы, что теперь гарантируется, полный результат R1 tests, что осталось blocked и следующий пакет R2. Никакого production/VM/live допуска по результатам этого pass.

Заверши весь R1, а не только happy path. Если есть реальный blocker, назови конкретный отсутствующий input/contract conflict/test и продолжай независимую часть. Routine implementation choices решай самостоятельно. Самостоятельно к R2/Q1B не переходи: результат R1 должен быть отдельно reviewable.
