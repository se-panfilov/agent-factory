# Copilot: завершить Q1A — core lifecycle, admission, state и gates

Скопируй текст ниже целиком в Copilot Agent из корня `agent-factory`. Вместе с ним дай доступ к новому review и прежнему аудиту в `audit/`.

---

Ты исправляешь `se-panfilov/agent-factory`. Выполни **один законченный remediation-пакет Q1A**, описанный ниже. Нужны рабочий код, meaningful regression tests и честный отчёт. План, новые stubs или косметическое переименование статусов не являются выполнением задания.

Проверенная исходная версия — `eb187a845820aed6ef7ebafcbd2f9ac9853179a3`; основной предыдущий remediation находится в `91c9899662ac8b524b874a03ce3e831cb1835d01`. На этой версии setup typecheck проходит, setup tests: 84 passed, но перечисленные ниже нарушения воспроизводятся.

## 1. Объём, источники и рабочий режим

1. Проверь current HEAD, branch и working tree. Сохрани чужие изменения. Если HEAD новее указанного, сначала изучи diff и проверь актуальность замечаний; не откатывай репозиторий. Работай в отдельной ветке `fix/core-q1a`, если ещё не выбрана отдельная рабочая ветка. Не merge, не publish, не deploy.
2. Прочитай `AGENTS.md`, `docs/automation/CONTRACT.md`, профильные части execution plan/architecture, `reviews/agent-factory-audit.ru.md`, `docs/audits/remediation-2026-10-22.md`, `setup/docs/privileges.md` и новый `reviews/agent-factory-production-review-eb187a8.ru.md` из вложений/репозитория. Сохрани новый review в `audit/reviews/`, если он доступен только как вложение.
3. Это явно разрешённая cross-cutting remediation core, а не новый одиночный Pxx. Можно согласованно менять core/adapters/stage integration/tests/docs в пределах Q1A. Не создавать параллельные задания на одни файлы.
4. Сохрани явный `StageContext.config`. Не возвращай `lastConfig` или другой process-local prerequisite. Сохрани хорошие части strict parser, approval preservation и primary-first atomic save.
5. Q1A не включает полную реализацию sudo/S03/S04, process-tree supervisor, package/M0/OAuth/live/restore payload/service/inference/GitHub. Эти работы остаются в Q1B–Q6. **Но обходы admission и ложный success в их public entrypoints должны быть закрыты уже здесь.** Временный explicit blocked — containment, а не закрытие соответствующего AF.
6. Тесты: temp FS, injected adapters, fake provider, безопасные локальные subprocesses. Запрещены реальные sudo/apt/systemd/SSH/firewall/Docker daemon, OAuth/model calls, GitHub writes и provisioning. Не запускать тестируемые privileged operations на машине разработчика, даже если процесс имеет root UID.
7. Не ослаблять CONTRACT, schema, gates и guards ради зелёных тестов. Public несовместимость оформляй отдельным ADR/versioned proposal; не меняй 1.0.0 молча. Если найден настоящий блокирующий конфликт контракта, объясни конкретный конфликт и продолжай независимую часть задания. Не задавай вопрос о рутинном выборе внутренних функций/модулей.

## 2. Зафиксированные дефекты, которые нужно устранить в Q1A

На проверенном HEAD:

| Сценарий | Наблюдаемое ошибочное поведение |
|---|---|
| `verify` с реальным S01 и неподдерживаемым host report | `S01=blocked`, но `exit=0`, `overall_status=ok` |
| Gate approve после TTL | Exit 0, хотя persisted status становится expired |
| Stage-only required gate, operations пустой | Успешный plan, ни одного persisted gate |
| Primary с in-flight effect повреждён, `.previous` старый чистый | Load возвращает inflight=null/error=null |
| Corrupt primary без `.previous`, load дважды | Первый load quarantines, второй создаёт чистую установку |
| S12 отключён config и возвращает skipped | Apply выдаёт `postcondition_not_verified`, exit 10 |
| Stage A подаёт cancel, затем stage B | Stage B всё равно исполняется; cancel замечен после всего цикла |
| Verify/status/backup/restore/auth/smoke и другие writers | Нет единой границы взаимного исключения и admission |
| Update verbs blocked | `next_action` советует generic S14, который не является безопасной заменой |

Полные воспроизведения — в новом review/evidence. Исправляй причины и соседние варианты, не добавляй условия под конкретные тестовые значения.

## 3. Truthful verification и exit codes

Сделай общий путь получения и свёртки результатов для apply/verify/status refresh/resume и других entrypoints. Используй внутренний typed result либо эквивалент без молчаливого нарушения публичного Stage API.

- Receipt — evidence операции, а не общий признак verified. Observation должен проверяться независимо от количества receipts. Mandatory negative checks не теряются.
- Для каждого stage различаются verified, legitimately skipped, blocked, failed, drifted/unknown. Итоговый envelope и exit code согласованы с C03.
- Required failure никогда не превращается в success. Unsupported host/resources → 3; missing gate/re-login → 4; missing capability/evidence → 5; ordinary operation/verification failure → 6; drift/recovery → 8; integrity/security → 9.
- Disabled optional stage без effects остаётся skipped и допускает exit 0; не превращать его в verified. Явно включённый/выбранный optional failed/blocked даёт 10 только когда mandatory часть выполнена; mandatory failure имеет свой приоритет.
- Verify без `--stage` охватывает выбранную установку согласно контракту, а не молча только S01. С `--stage` показывай target и closure. Read-only verification не запускает модель/установку.
- `status` без refresh явно показывает recorded state и возраст; не инициализирует и не «лечит» state как скрытый side effect.

## 4. Gate lifecycle, binding и plan admission

Сделай одну явную модель required approvals. Проверь все существующие stage definitions и callers.

- Устрани расхождение `required_gates` и `operations[].gate_ids`: plan должен показывать все необходимые approvals, а apply проверять именно approvals исполняемых effects. Если это одна сущность в двух представлениях, проверяй их согласованность; не теряй stage-only declarations.
- Отличай approval от external prerequisite. `bootstrap-required`, отсутствие M0, unsupported host и failed isolation probe нельзя удовлетворить нажатием approve.
- Используй один injected clock в create/list/approve/apply/recovery. `now >= expires_at` — expired. Approve expired возвращает ненулевой результат/manual action; повторный upsert/approve не продлевает TTL. Valid approval того же неизменённого action сохраняется.
- Одобрение должно иметь однозначную связь с operation type/id или явно объявленным reviewed набором operations, host/installation, plan/config, resource, owner session и expiry по C09. Совпадение текстового gate ID недостаточно. Shared gate IDs не должны молча перезаписывать binding последней операцией.
- Проверка плана включает installation identity, supported contract, profile, DAG closure, ordering/duplicates, selected operations, required capabilities и допустимый entrypoint. Проверять schema/hash недостаточно.
- Фактические reviewed lock/release bytes и существенные observed resources должны участвовать в admission: изменение содержимого по тому же пути делает старое approval непригодным. Не считать checksum плана подписью/авторизацией.
- Повторно проверяй admission после получения lock и перед эффектом. Не используй заранее прочитанный mutable plan/config как единственный источник истины. Не держи возможность подменить конкретный backup/release/resource между approval и исполнением.
- Перед любой production mutation проверяй ordinary owner identity: root, неизвестный UID и несоответствие expected owner отклоняются. Не предлагай запуск всего CLI через sudo для обхода этой проверки. Полный narrow privileged executor относится к Q1B/Q2.
- Central entrypoint policy обязана запрещать generic apply для update, auth/live, restore и других действий, для которых контракт требует отдельную явную команду. S14 не включается через generic stage selection. Dedicated update остаётся честно blocked до Q5; совет обходить это generic S14 удалить.
- Для public restore до исправления payload/confinement и transaction в Q4 — explicit blocked до чтения/копирования payload, с точной причиной. Наличие любого `--plan` не является restore approval.
- Для других незавершённых опасных production adapters — explicit capability blocker до mutation. Не добавляй публичный env/CLI-флаг обхода. Tests могут инъецировать безопасные adapters программно. Отдельно покажи, какие действия остались disabled.

## 5. State durability и recovery без потери неопределённости

Определи и реализуй commit/recovery protocol для current, previous и journal. Документируй порядок write/fsync/rename и поведение при отказе каждого шага.

- Сохрани отсутствие delete/rename-away primary до готовности replacement.
- Проверяй schema, installation/host identity и целостность recovery candidate **до** замены current. Повреждённые байты сохраняй как evidence. Missing/invalid machine/boot identity — typed blocker, не общий hash от `unknown-machine-id`.
- Fresh installation и damaged existing installation должны различаться устойчиво. Quarantine, journal или recovery marker не должны исчезать для логики следующего load. Повторные load/init/apply/resume не снимают recovery-required.
- Старый `.previous` не доказывает отсутствие более позднего side effect. Сопоставляй durable intent/receipts/наблюдаемые ресурсы; неизвестный результат остаётся unknown и запрещает автоматический replay опасной операции.
- Все mutations state проходят под соответствующим lock/transaction; никаких `loadState` с записью до lock. Раздели read-only load/validate и explicit initialize/recover/write.
- Не обновляй config_hash автоматически ради исчезновения drift. Изменение desired config требует нового admission/plan/approvals; путь принятия нового baseline должен быть явным.
- Сбой обновления `.previous` после commit primary не должен выдавать двусмысленное «ничего не сделано». Следующая команда однозначно определяет committed generation/recovery status. Не требую конкретного формата generations, требую доказуемого поведения.
- Journal intent должен соответствовать действительно начинающемуся эффекту. Убери запись intent всех operations перед одним непрозрачным apply. Используй внутреннюю обёртку/исполнитель операции с durable intent перед effect, receipt после и обязательной проверкой before marking complete, сохраняя контракт StageModule.
- Если старый adapter ещё не может безопасно работать через этот протокол, его production mutation остаётся blocked до адаптации; это отражается как OPEN. Нельзя имитировать выполненные операции synthetic receipts или просто очистить inflight в catch.

## 6. Lock, concurrent commands и cancellation

Составь таблицу всех public commands: read-only, serialized writer, cancellation request, emergency/recovery. Проверь каждый route, а не только plan/apply.

- Все обычные state/resource writers используют единое взаимное исключение: plan, approve, apply/resume, refresh/verify с записью, backup, restore, auth/live usage, inference disable, update и другие фактические writers. Для blocked commands отказ должен происходить до effects. Read-only commands читают согласованный snapshot без скрытой записи.
- Обычный код не удаляет чужой lock. Проверять полную релевантную identity, включая nonce, boot, PID/start ticks, installation. PID reuse, missing/invalid identity и reboot рассматриваются явно.
- Устрани гонку mkdir lock → запись owner: recovery не должен принимать незавершённую запись живого владельца за разрешение убрать lock. Используй доказуемый protocol, не arbitrary sleep как гарантию безопасности.
- `recover --lock-only` не разрешает replay и не объявляет cleanup ресурсов. Отдельно сохраняется recovery-required для незавершённых children/containers/external effects.
- Cancel — отдельный атомарный запрос к точному run. Он не ждёт exclusive lock отменяемого apply. Старый/corrupt request не отменяет новый run; request не должен теряться из-за частичной записи.
- Проверять cancel перед первым и каждым следующим effect и между operations. Передай cancellation context активному adapter; в Q1A проверь это безопасными fake adapters, которые моделируют completion/unknown cleanup. Полная реализация process-tree handling — Q1B, и её отсутствие остаётся blocker соответствующих production paths.
- Подтверждённая отмена/cleanup → 130 или 143 по причине сигнала; неподтверждённый cleanup → 8 с durable recovery evidence. Не выдавай 130 только потому, что записан cancel-request.
- Emergency cancel/recovery должны иметь отдельный race-safe протокол; запретить deadlock «cancel ждёт того, кого должен остановить». Обычные readers/writers не получают права emergency bypass.

## 7. Обязательная приёмка Q1A

Тесты проверяют внешне наблюдаемые invariants. Используй реальные отдельные Node processes для concurrency/lifecycle, временные каталоги, детерминированные barriers/fake clock/fault injection. Не подменяй весь engine fake-реализацией. Host effects допускаются только через безопасные injected adapters; test entrypoint не должен становиться публичным bypass production CLI.

| ID | Сценарий | Обязательный результат |
|---|---|---|
| A01 | Отдельные subprocesses plan→approve→apply→verify→resume, смена cwd | Нет shared-memory prerequisite; одобрение сохраняется; ожидаемый effect ровно один |
| A02 | Реальные stage factories S05–S07 с config/adapters в свежих процессах | Не требуется предшествующий plan в том же процессе; failure не маскируется fixture manifest |
| A03 | Real S01 с unsupported/root host; stage verify даёт receipts с negative checks или пустые receipts | Exit/envelope не объявляют readiness; отрицательный observation сохраняется |
| A04 | Optional disabled/skipped; enabled selected failed; mandatory failed вместе с optional failure | C03 0/10/соответствующий mandatory code; skipped не становится verified |
| A05 | Gate до/на/после TTL; repeated upsert; new plan; repeated gate ID для разных resources | Нет ложного approve success, TTL продления, потери или переноса approval |
| A06 | Stage-only gate; operation-only gate; missing bootstrap/M0 | Полный согласованный список approvals; prerequisite нельзя переодобрить вместо проверки |
| A07 | Подменены host/installation/profile/lock bytes/release/resource/session; нарушен DAG | Refusal до эффекта даже при синтаксически валидном плане и пересчитанном checksum |
| A08 | Crash/ENOSPC/fsync/rename failures на каждой границе current/previous/journal | Нет потери последнего committed state и неопределённого effect; recovery deterministic |
| A09 | Corrupt current без previous; два последовательных load; corrupt/missing previous | Persistent recovery-required; нет fresh-state reset; candidate не записан до проверки |
| A10 | Previous старее последнего intent; эффект произошёл, receipt не записался; resume | Unknown сохраняется; опасное действие автоматически не повторяется |
| A11 | Конкурирующие plan/approve/apply/verify/backup/restore/smoke routes | Нет потерянных updates/duplicate effects; writer без lock не начинает mutation |
| A12 | PID reuse/reboot, foreign nonce, missing/partial owner и concurrent recover | Не удаляется активный/чужой lock; stale lock не означает отсутствие orphan effect |
| A13 | Cancel внутри stage A перед stage B; old cancel; interrupted request; cleanup unknown | B не запускается; новый run не затронут; 130 только с cleanup proof, иначе 8 |
| A14 | Generic S14/update; public restore с чужим/обычным планом; опасный unqualified adapter | Explicit blocker до effects; нет советов/флагов обхода |
| A15 | CLI unknown/duplicate/missing flags, rejected enum, public exception | Один sanitized JSON envelope и правильный code; без stack/raw secret fixture |
| A16 | Positive controls: valid plan/gates/state, verified no-op, повторный безопасный run | Рабочий путь сохраняется; нельзя «исправить» suite blanket отказом всех команд |

Минимум добавь regression cases для всех указанных дефектов и соответствующие позитивные controls. A02 проверяет независимость stage context от процесса: допустим одинаковый корректный typed blocker из-за реального отсутствующего prerequisite, но недопустим lastConfig-related failure или фиктивный успех. Она не требует чинить весь M0 manifest в Q1A и не заменяет Q3 packaged E2E. A13 с fake adapter не квалифицирует реальный process tree. Явно различай эти уровни доказательств.

Для новых tests покажи failing-before/passing-after на исходном remediation HEAD, где это технически применимо. Если тест требует нового API, отдельно опиши исходное воспроизведение; не выдумывай red run. Количество tests — не критерий PASS само по себе.

Запусти минимум:

```bash
npm --prefix setup ci --ignore-scripts --no-audit --no-fund
npm --prefix setup run typecheck --silent
npm --prefix setup run test --silent
```

При изменении root application contracts запусти также соответствующие существующие root checks. Сначала убедись, что tests не вызывают реальный Docker/sudo/network/provider. Не расширяй testing без причины после прохождения нужных checks.

## 8. Документация и результат

1. Добавь `docs/audits/remediation-q1a-2026-10-23.md`: исходный SHA, проверенный source tree/коммит, scope, изменённые invariants, результаты A01–A16, реальные команды/exit codes, NOT RUN, known blockers. Не записывай старый baseline как Current HEAD и не пытайся включить self-referential hash отчётного коммита; различай source commit и commit отчёта.
2. Обнови матрицу AF-01…AF-31: отдельно code fix, regression evidence, VM/live qualification. AF-02 не PASS без expired-approve и полного lifecycle. AF-30 не PASS из-за одного outputLimitExceeded. Disabled/contained subsystem остаётся OPEN по реализации.
3. Исправь `setup/docs/privileges.md`: действительная таблица operation→argv→UID→inputs/paths→gate→postcondition→recovery и implemented/blocked/planned. Утверждение о single lock допустимо только после покрытия всех writers. Не описывай S03 rollback или sudo boundary как готовые до их реализации.
4. Исправь название старого «separate engine processes» теста либо замени его настоящим subprocess test; сохрани полезное покрытие разных экземпляров.
5. В итоговом сообщении дай: что работает теперь; что всё ещё blocked; список изменённых security-sensitive файлов; команды и результаты; A01–A16 PASS/FAIL/NOT RUN с evidence; нерешённые AF; следующий пакет Q1B. Кратко укажи, что владельцу делать сейчас.

Работай до полного выполнения Q1A в доступной среде. Не заканчивай после нескольких удобных исправлений с заявлением о закрытом core. Если остаётся препятствие, назови точный test/contract/input, что сделано, что заблокировано и почему; не скрывай это за «почти production». Даже полностью зелёный Q1A не является разрешением запуска live/privileged paths: это решение принимается после последующих пакетов и их evidence.
