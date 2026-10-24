# Copilot: Q1A-R1.3 — согласованные stage producers и единая recovery admission

Работай в `se-panfilov/agent-factory`. Это задание на реализацию исправлений **R12-F01…R12-F05** из `reviews/agent-factory-r12-audit-13f6137.ru.md`. Заверши пакет, а не только подготовь план.

**Baseline:** `13f6137e414a563f9f4e152f9145245e175a2d1b` (`audit fixes 6`). Если master изменился, зафиксируй актуальный SHA и проверь diff до начала работы. Сохрани чужие изменения; никаких reset/clean/rewrite history.

**Цель:** убрать регрессии настоящих stages, сделать фактический operation progress durable и обеспечить одинаково строгую проверку полного recovery evidence на всех ветках. R1.2 принят частично. Не начинать R2/Q1B, не объявлять весь Q1A/AF-05/06 или production закрытыми.

## 1. Источники и границы

Прочитай `AGENTS.md`, `docs/automation/CONTRACT.md`, `audit/copilot-r12-task.ru.md`, текущий аудит и R1.2 report. Требования этого пакета уточняют уже поставленные обязательства; не ослабляй contract 1.0.0, public CLI/schema/exit codes или security guards.

Разрешены необходимые изменения core, внутренних типов/API execution, stage producers, adapters для injectable boundaries, tests, docs и evidence. Public state schema не расширять через `as any`/невалидируемые поля. Версионированная внутренняя metadata допустима с явными migration/legacy/crash правилами. При настоящем конфликте с нормативным contract назови точное место и предложи решение; независимую часть продолжай.

Тесты: temp FS, fake process/APT/Docker/access/application/network adapters, локальные child processes. Не выполнять real sudo/apt/systemd/SSH/firewall/Docker daemon/OAuth/model/provider/GitHub writes/provisioning. Не merge/deploy/publish. Сохрани generic S08/S14 containment, owner/lock/gates, read-only diagnostics, bounded reads. Полная runtime/privileged qualification остаётся последующими пакетами.

## 2. Зафиксируй regressions до исправления

Распакуй `evidence/agent-factory-r12-evidence-13f6137.zip` вне исходников. Scripts N-cases **подтверждают дефект на baseline**; их exit 0 не означает product PASS. Перенеси scenarios в regression suite с безопасными ожиданиями.

| Evidence | Сейчас | После исправления |
|---|---|---|
| S04 same-fixture comparison | Baseline b0bc219 apply/status=0; 13f6137 apply/status=8 после fake install/restart/probe | Настоящий supported S04 через engine завершается корректно; unsupported path блокируется до effects |
| S07 comparison | Baseline apply/status=0; 13f6137 resource-mismatch/8 после создания offline report | Resource/operation evidence согласовано, нормальный lifecycle работает |
| S03 / S05 controls | На обеих версиях apply=2: gate representation / capability mismatch, effects=0 | Согласованный production plan проходит структурную admission; capability/security blockers остаются правдивыми |
| Core N01 | Old effect checkpoint разрешает восстановить previous, хотя manifest описывает newer unknown state | Exit 8, evidence/unknown не потеряны |
| Core N02 | Остался только state-commit.json: recover объявляет fresh, plan перезаписывает историю | Не fresh; typed recovery blocker, manifest сохранён |
| Core N03 | primary_restored + противоречащий quarantine → marker удалён, recover=0 | Exit 8 до cleanup, marker/evidence сохранены |
| Core N04 | Proven missing primary: direct recover=0, но plan→recover=8 из-за reason | Одинаковый безопасный результат при одинаковом proof; ambiguous case остаётся blocked |
| Core N05 | S02 refresh/simulate завершены, install падает; journal содержит только заранее записанные intents | Durable progress завершённых операций есть до входа в следующую; unknown не replay-ится |

N01/N02/N03 моделируют потерю/смешение recovery artifacts. Не заменяй эти tests отрицательной проверкой заведомо невалидного checksum или чужой installation: inputs должны быть schema-valid и относиться к той же installation.

## 3. Сначала согласуй все поддержанные producers с engine

Составь inventory **S00…S14**, а не только S00/S01/S02/S06/S12+. Для каждой стадии перечисли: выбранный profile/entrypoint, плановые operation IDs/kinds/resources, stage-level и operation gates/capabilities, реальные effects, возвращаемые receipts, no-op path, supported/blocked status. Этот inventory должен отражать конечный код.

Исправь подтверждённые расхождения:

- **S04:** единственный receipt `resource-probe` сейчас относится к verify operation, исключённой из списка effects; мутации install/config/restart/group остаются без собственных receipts. Resource probe создаёт временные Docker resources: согласуй классификацию и cleanup evidence, не скрывай эффект одним словом `verify`.
- **S07:** plan resource `runner-offline-verification` против receipt `runner-ready-offline`. Убедись, что нормализованная identity подтверждает фактически выполненную operation, а не просто совпадает строкой.
- **S03:** operation gate IDs и stage required gates должны быть согласованы при manual flags как true, так и false. Ready observation не заменяет требуемый approval. Кроме того, один stage-wide receipt `access-cutover` не соответствует набору operations/resources.
- **S05:** согласуй profile-dependent plan capabilities и stage declaration, различая входные requirements и проверяемые capabilities устанавливаемого release. Не ослабляй проверку release manifest/probes ради прохождения structural validator. Исправь resources staging/release/checkout и соответствующую семантику receipts.
- **S09/S10:** проверь и исправь известные resource mismatches из аудита; не объявляй optional live/service support без положенного evidence. При отсутствии capability path должен честно блокироваться до mutation.
- Прочие producers также проверь. Отсутствие строки в прошлом отчёте не означает совместимость.

Проверки выполняй через настоящие `SetupEngine.plan → gate-approve → apply → status/verify/resume` и настоящие stage modules с fake adapters. Не заменяй stage «идеальным» fake producer, не обнуляй gates/capabilities и не вызывай private validator в обход обычной admission, чтобы получить зелёный test. Подставные prerequisites допустимы, но должны быть явно названы.

Сохрани strict rejection missing/duplicate/foreign/unplanned receipts. Если необходимая producer capability ещё не поддержана, проверь это до первого эффекта и выдай конкретный blocker. Для обязательного supervised scope требуются положительные lifecycle cases; нельзя закрыть пакет глобальным запретом всех stages.

## 4. Реализуй настоящий durable operation boundary

Текущий цикл «все intents → один stage.apply → все receipts» не выполняет поставленное требование. S02 receipts в локальном массиве теряются при поздней ошибке.

- Введи минимальный внутренний executor/callback/step boundary, при котором engine остаётся единственным владельцем core state/journal.
- Для каждой фактической операции: разрешённая identity/attempt, durable intent перед эффектом, фактическое evidence после эффекта и **до старта следующей operation**, затем предусмотренные verify/checkpoint steps.
- Не записывай intent операции как доказательство её исполнения. Не создавай receipts задним числом по stage success. Если несколько действий действительно являются одной неделимой operation, это должно быть согласованно выражено в плане и protocol; нельзя молча агрегировать существующий многооперационный план.
- Если вторая/третья операция падает или процесс убит, сохраняется известный progress предыдущих и uncertainty текущей. Не replay-ить неизвестный эффект и не объявлять stage verified по частичному успеху.
- Конкретная durable completion boundary для stage-wide postconditions должна быть явно описана; ранний effect receipt не равен общему verified checkpoint.
- Empty/verify-only plan по-прежнему не вызывает effectful apply. Повторная настоящая S06 остаётся рабочей. Для verification, создающей temporary resources, предусмотрено соответствующее ownership/cleanup evidence; не обещай полную purity такого probe.

Полный process supervisor и все per-effect cancel/expiry гарантии здесь не требуются. Нужен именно минимум execution protocol, без которого R1 journal не отражает фактический progress. Если встроенный механизм позволяет сделать необходимые проверки admission у каждого effect без расширения scope, используй его; не выдавай это за завершение будущего R3/Q1B.

## 5. Единые правила для всего recovery evidence

Сначала определи короткую таблицу состояния: primary, previous, quarantine, journal, manifest, marker/decision, known/unknown generation. Реализуй общий evaluator или эквивалентный единый источник правил; не добавляй несколько противоречащих друг другу if по отдельным N-cases.

Обязательные правила:

1. **Manifest — самостоятельное durable evidence.** Его наличие/ошибка чтения/неподдержанная версия учитываются до fresh initialization и раннего `recovery_not_required`. Commit metadata нельзя молча заменить новым fresh state.
2. **Latest effect checkpoint не равен latest state generation.** Для восстановления candidate требуется proof, что он представляет безопасное committed поколение и не скрывает более новый unknown state. При `last_state_hash != candidateHash` старого `last_effect_checkpoint` недостаточно. Если допускаешь восстановление через цепочку безопасных metadata-only переходов, эта цепочка должна быть проверяема; иначе exit 8.
3. **Prepared decision остаётся immutable.** Сохрани уже исправленные проверки substituted previous/current, exact candidate identity и typed persistence failures. Свяжи decision с нужной generation/proof, а не только свободным совпадением hash старого snapshot.
4. **Cleanup проходит полную admission до удаления marker.** `phase=primary_restored` не разрешает игнорировать новые/противоречащие quarantine/journal/manifest/in-flight artifacts. Не стирай marker перед проверкой blockers; reader не должен «поймать ошибку позже», когда часть evidence уже удалена.
5. **Marker reason не заменяет evidence.** Proven recovery должно корректно работать как при прямом recover, так и после обычного plan/resume, записавшего marker. Устрани несовместимость `state_missing_with_recovery_evidence` и разрешённого reason; не добавляй blanket разрешение для любого marker.
6. **Согласуй commit и crash semantics** для state/previous/manifest/journal/checkpoint proof/marker. На каждом partial write допускается только доказуемое продолжение либо честный unresolved. Fresh reset, false consistent, потеря unknown и automatic replay запрещены.
7. **Read-only остаётся read-only.** Общий evaluator не должен делать cleanup, migration или marker writes в status/gate-list diagnostics. У writable/recovery path один lock; cancel остаётся доступен при damaged state.

Положительные safe recovery fixtures создавай штатными engine/writer calls. Вручную нарисованный matching checkpoint к old previous при несовпадающем current manifest не является safe proof. Проверяй согласованность исходного fixture до удаления/повреждения primary.

## 6. Приёмка T01…T12

ID предыдущих замечаний не переименовывать и не сдвигать. T-критерии ниже дополняют прежние K; mapping findings→tests должен быть точным.

| ID | Test | Обязательный outcome |
|---|---|---|
| T01 | Настоящие S04/S07 через engine, same fixtures на b0bc219/13f6137/fix | На baseline 13f6137 воспроизведён дефект; на fix нормальный supported lifecycle и receipts; adapter counts проверены |
| T02 | S03/S05 structural admission и inventory всех registry stages | Корректно созданные планы не отвергают сами себя; запреты/capabilities/gates не ослаблены |
| T03 | S02 refresh→simulate→install, поздний error и отдельный process interruption | Evidence предыдущего эффекта durable до входа в следующий; неизвестное сохраняется, stage не false-verified |
| T04 | Complete old checkpoint + newer manifest state с unknown, primary потерян | Exit 8, previous/manifest/journal не перезаписаны старым поколением |
| T05 | Manifest-only installation; malformed/foreign/unsupported manifest | Не fresh, typed blocker, отсутствие history reset; чтение не мутирует |
| T06 | Prepared/primary_restored с конфликтующим primary/previous/quarantine/journal/manifest | Exit 8 до overwrite/cleanup, decision и evidence сохранены |
| T07 | Доказуемый safe recovery напрямую и после plan/resume marker | Оба пути безопасно восстанавливают одно поколение; неизвестный соседний case blocked |
| T08 | Manifest и checkpoint proof write/fsync/rename/dir-fsync faults | Exact injected boundary/hit; правильный durable old/new/unknown outcome; повторная команда не делает false success |
| T09 | Recovery decision/restore/cleanup faults | Независимый fixture на каждую границу; typed exit, correct next action, exact candidate сохранён |
| T10 | Отдельный writer, barrier до/после важной operation/commit phase, reader/full recover, SIGKILL/restart | Нет скрытых writes читателя, foreign lock уважается, unknown не replay-ится |
| T11 | Положительные S00→S01/S02/S06, no-op/verify-only traps, legacy guards | Ранее исправленные paths работают; applyCalls=0 для no-op; bounded/schema/attempt guards сохранены |
| T12 | Полный suite Node 24, чистая code identity, воспроизводимый evidence bundle | Реальные команды/логи/exit codes; корректные finding IDs; PASS ограничен фактическими assertions |

T08 обязан проверять новые `state-commit.json` и `recordEffectCheckpoint` boundaries, а не ссылаться только на прежний state/previous fault test. Учти отсутствие manifest, старый/новый manifest, checkpoint append до binding, cleanup при изменившемся evidence. Полная физическая power-loss qualification здесь не требуется и помечается NOT RUN.

Для каждой fault injection проверь hit/count/path/phase, snapshots/hashes до и после, число adapter effects и результат следующей команды. Исходный fixture восстанавливай заново, не переиспользуй мутировавшую директорию. Fault-off negative control должен выявлять отсутствие ожидаемого fault. Одного `exit != 0`, названия теста или количества тестов недостаточно.

T10 координируй через IPC/условие barrier. Существующий K10 сохранить; он полезен, но проверяет только одну границу. Не называть lock-holder или новый engine в том же процессе полным interrupted-writer matrix.

## 7. Evidence и завершение

На **настоящем Node 24** выполни и сохрани выводы:

```bash
node --version
npm --version
npm --prefix setup ci --ignore-scripts --no-audit --no-fund
npm --prefix setup run typecheck --silent
npm --prefix setup run test --silent
```

Текущий `13f6137` уже независимо проверен на Node v24.19.0: 123/123. Это не освобождает от прогона исправленного кода. Не имитируй Node 24 подменой `process.versions` в validation run; изолированные unit fixtures для version guard — отдельный допустимый тест.

Добавь `docs/audits/remediation-q1a-r1-3-<actual-date>.md`, обнови protocol document, stage inventory и воспроизводимый пакет. В отчёте нужны:

- baseline и точный **tested code commit/tree hash**. Если использовался working tree — приложенный patch, staged/unstaged/untracked состав и hash проверенного code tree, а не только hash неизвестного diff;
- правильный mapping R11-F01…F06 и R12-F01…F05, K01…K12 и T01…T12: PASS/PARTIAL/OPEN с реальным test/assertion;
- отдельные code status, local test status, real-host qualification; не объединять в общее «всё PASS»;
- исправленный полный список producers и оставшиеся намеренно blocked routes с причинами;
- same-fixture before/after для актуальных counterexamples. Старый N07 в R1.1 runner имеет разные baseline/fixed fixture и не заменяет это сравнение;
- scripts, machine-readable results, полный test log, фактическая fault matrix и команды воспроизведения из чистых worktrees; никаких обязательных ссылок только на локальную Copilot session directory;
- checksum ZIP и точная code identity отдельно от packaging metadata; не создавать невозможный self-referencing package/commit hash;
- correction note к прошлому отчёту с конкретным исправлением finding-ID mapping и packaging SHA, без переписывания прошлых results как будто новые tests выполнялись тогда;
- real sudo/apt/systemd/SSH/firewall/Docker/OAuth/model/provider/GitHub writes/VM/VPS/power-loss — **NOT RUN**.

Не ослабляй старые assertions ради green. Не закрывай unresolved case ручным удалением marker/journal/manifest. Рутинные решения принимай самостоятельно, продолжай до завершения разрешённого пакета. Если остаётся blocker — назови конкретный invariant и сохрани PARTIAL/OPEN. Верни code SHA, фактические результаты и следующий шаг для review; не начинай R2 автоматически.
