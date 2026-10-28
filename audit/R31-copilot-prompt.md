# Copilot: Q1A-R3.1 — оставшиеся границы cancel/emergency и переносимость evidence

Выполни **только Q1A-R3.1** по `reviews/R3-audit.md`: исправь R31-F01…F04, сохрани принятые lock/identity/recovery/R221 invariants и подготовь локальный воспроизводимый пакет. Не начинай полный Q1B/Q2–Q6 или разработку приложения фабрики.

**НЕ делай коммиты. НЕ пушь. НЕ создавай ветки, worktree или PR. НЕ выполняй merge/tag/release/deploy. НЕ используй staging/index, включая `git add -N`, для упаковки. Все изменения должны остаться локально. Повторяй эти запреты во всех следующих промптах, которые создашь для ИИ-агентов.** Публикация владельцем — отдельное действие.

Не запускай реальные sudo/APT/systemd/SSH/UFW/Docker-daemon, VM/VPS provisioning, OAuth/provider/model calls; не используй credentials и не меняй удалённые сервисы. Работай с owned temp FS, injected adapters и, если нужны, безопасными локальными child processes. Не ослабляй root/owner checks и не меняй OS identity ради tests.

## 1. Исходные bytes и принятый результат

Проверенный master: **`e217f397b952942b62e847788dc2e6698ad6d7e5`**, tree `41fe20304e340133bd7e217aceea674c466015e3`. Parent `b92e833c3d743d2f15975ee6433b453f07f173b8`; product baseline предыдущего R3 —134ecd884ab77f537f1890b3dd456cc6592090ad. Пакет предыдущего исполнения: `audit/evidence/q1a-r3-2026-10-27-local/`, ZIP SHA256 `393d139d18f0c7fef2fff4b50a4494ba220dba1a3e9fd249c6e3d6d653e3f162`.

Reviewer package: `R3-evidence.zip`, checksum в `R3-checksums.sha256`. Не выдумывай hash. Сначала безопасно распакуй в отдельный inspection directory и прочитай `evidence/README.md`. Входные attachments и master совпали по всем270 tested inputs.

До source edits прочитай AGENTS.md, CONTRACT1.0.0, особенно C03/C07/C09/C12/C13, текущие `lock-cancel-r3.md`, `plan-context-r22.md`, `privileges.md`, `operations.md`, `reviews/R3-audit.md` и этот prompt. Не запускай всю последовательность P00–P15. Старая запись design-only не описывает нынешнее фактическое дерево.

Сохрани HEAD/tree/branch/status, index SHA256, hashes relevant tracked/untracked files, owner staged/unstaged bytes. Не reset/clean/stash/checkout. Snapshot/reconstruction — обычные directory copies или `git archive`, без index/worktree. Если HEAD отличается, явно сравни delta: audit-only не является новым product baseline; продуктовый diff требует проверки. При внешнем сдвиге HEAD/index зафиксируй событие и доступные bytes без необоснованной атрибуции. Отсутствующие исторические bytes раннего R3 index не восстанавливай выдумкой и не делай их условием нового исправления.

**Сохранить:** строгую full lock generation, alive/dead/unknown, protocol mutex, non-reclaiming guard, resource-aware отказ перед quarantine, atomic cancel publication/read-only consumption, finite R221 fence, prepared/committed review, exact journal/receipt bindings и no-replay.

R211-O01 теперь принят как честный recovery8/fresh-review outcome. Не возвращай auto-approval или recover0 ради старого oracle. O02 historical cause OPEN; новая проблема UID не является её доказанной причиной.

## 2. Сначала воспроизведение и фиксация baseline

Reviewer получил на exact master Linux/Node24.22.1/actual UID0: typecheck PASS, **574/589 tests**,15 failures. Все74 новых R3 tests прошли. Причина15 failures — три fixture calls в `requestCancel` без ProcessAdapter. Diagnostic copy с тремя поправками test calls дала589/589 при неизменных production bytes. Исходные S03 и R3 standalone runners также используют omitted adapter; после явной передачи существующей fixture identity они дали13/13 и14/14. На macOS/UID501 эта ошибка скрыта.

В reviewer package есть:

- `diagnostic-fixtures-only.patch` — три точечных test-call изменения; это диагностическое доказательство, не автоматически принятый product patch.
- `runner-identity-mapping.patch` — отдельные current-source runner copies с existing test identity; originals сохранены.
- `r31-boundary-probes.cjs`, `check-r31-boundaries.py`, raw JSONL и baseline/desired oracles.
- Раздельные raw результаты original, diagnostic и remaining-matrices runs. Они **не объединены** в один all-in-one PASS.

После сборки exact baseline запусти новый reviewer collector с сохранением stdout/stderr/exit/signal/duration:

```bash
node /absolute/evidence/r31-boundary-probes.cjs /absolute/baseline-repo > /absolute/output/r31-baseline.jsonl 2> /absolute/output/r31-baseline.stderr
python3 /absolute/evidence/check-r31-boundaries.py --mode baseline /absolute/output/r31-baseline.jsonl
python3 /absolute/evidence/check-r31-boundaries.py --mode desired /absolute/output/r31-baseline.jsonl
```

Ожидается **14 complete cases,7 desired PASS/7 FAIL**, collector0, baseline checker0, desired checker1. Collector0 не является product PASS. Проблемные cases: C-v2-missing-field/C-v2-extra-field/C-unknown-version; E-no-inventory/E-empty-inventory; E-throw-stop/E-throw-after-prefix.

Не менять original probes/raw. После refactor допускается отдельный mapped runner с явной таблицей изменённых API/barriers; сохраняй exact case semantics, useful positives, counters, ownership и proof, что hook сработал. Не заменяй содержательный refusal ранним harness failure.

## 3. R31-F01 — строгий parser cancellation evidence

Проблема: `consumeCancelRequest` бросает8 только на parse/read/metadata error, а invalid schema/owner/version выражается как false и разрешает apply. В probes сначала принят настоящий matching request при counters0/0/0, затем введён semantic JSON fault; сейчас все три негативных случая заканчиваются exit0 и APT1/1/1.

Требования:

1. Раздели bounded decode, проверку version/schema и comparison с текущим run. Сначала доказательство допустимости формата, затем решение matching/stale; не объединять их одним boolean expression.
2. Schema2 должна строго проверять exact fields/types и полноценный owner: installation/boot/PID/start ticks/nonce/created_at. Missing/extra/wrong-type/invalid fields →typed8 `cancel_evidence_unknown` либо более точный стабильный code, **effects0/events0**, файл сохранён.
3. Unknown schema version не считать legacy и не игнорировать. Duplicate JSON keys, arrays/null, truncated/oversized/invalid UTF-8, unsafe type/metadata/symlink остаются fail-closed.
4. Если сохраняется совместимость с legacy unbound cancellation, распознавай именно известный старый bounded формат. Он не получает authority для нового run. Не вводить generic «anything that is not v2 is old» fallback. Валидный stale request должен оставаться безопасным no-op.
5. Matching valid request по-прежнему даёт130 до нового intent; request не удаляется. Ошибки repeated publication не портят принятый request. Concurrency/generation protocol не переписывать.
6. Не открывай снова R221 check/use окно: любые новые async reads должны завершаться до existing final metadata fence/TTL/gates. Не заменяй validation пересозданием файла или silent cleanup.

Нужны controls: no request, valid matching, valid stale, recognised legacy, broken JSON; негативы: missing start ticks, extra key, unknown version, invalid owner field/type. Проверяй настоящий SetupEngine/S02, durable file/evidence и journal, а не только возврат helper.

## 4. R31-F02 — Docker discovery независимо от advisory inventory

Проблема: `docker=false` по умолчанию, live query включается только при наличии nonempty local inventory. В штатной trusted fixture при неизменном fake daemon с own running container удаление файла либо labels=[] даёт exit0/commandsDocker0 и контейнер продолжает работать. App stop/status не является доказательством container cleanup.

Требования:

1. Определи и реализуй источник обязанности проверять owned Docker resources. Для известного Docker deployment отсутствие/пустота/устаревание local inventory **не отключает live discovery**. Inventory может быть дополнительной подсказкой; он не доказывает отсутствие workload.
2. Discovery использует фиксированную проверенную installation identity и закрытые argv. Не исполнять arbitrary label/ID/options из файлов. Live empty list — отдельное доказательство, отличное от daemon unavailable/permission denied/malformed output.
3. Проверь каждый target перед stop, затем postcondition; known foreign пропускается и отражается в результате. Unknown ownership/status даёт typed non-success, не benign foreign. Не останавливать чужие ресурсы, не prune, не broad cleanup, не использовать sudo docker.
4. Сохрани полезный positive path для реальной no-Docker конфигурации **если она поддерживается**. Он требует доказанного отсутствия соответствующей обязанности/ресурсов, а не одного отсутствующего файла. Не вводи обязательную установку Docker для такого случая. Если отсутствие ресурсов не доказуемо, верни понятный blocked/recovery action.
5. Если known owned workload остановлен только частично или postcondition неизвестен, не возвращать overall ok. PAUSED и подтверждённый prefix сохраняются. Отсутствие app-status capability не компенсировать invented command или утверждением о полном stop.
6. Пока используются fake daemon и injected runtime facts. Не реализовывать весь Q2 Docker host executor в этом проходе и не объявлять real Docker qualification.

Обязательные сценарии: nonempty inventory control; отсутствующий файл; valid empty inventory; stale/incomplete advisory inventory; live empty daemon; own+foreign workloads; недоступный daemon; malformed/truncated inspect; failure после первого confirmed stop. Same live facts должны давать одинаковое решение о необходимости проверки при наличии и отсутствии advisory файла.

Пример strong positive: own container остановлен, post-inspect Running=false, foreign untouched, оба exact IDs отражены в результате. Пример negative: daemon неизвестен →nonzero и честный recovery action, без предположения «контейнеров нет».

## 5. R31-F03 — единый результат emergency failures

Проблема: result.exitCode!=0 уже переводится в typed8, но thrown/rejected adapter errors обходят эту обработку. В одном probe own container был остановлен и postcondition подтверждён, затем inspect другого target выбросил EIO. Caller получил6 unexpected_error и generic fresh-plan retry; confirmed prefix исчез из envelope.

Требования:

1. Явно раздели pre-admission refusal, publication of PAUSED, attempted stop, confirmed stop и unknown outcome. Нельзя любой exception превращать в «не начинали» или считать PAUSED доказательством complete cleanup.
2. Обрабатывай и returned failures, и thrown/rejected errors из process/FS/admission checks в emergency flow. После частичных effects сохраняй PAUSED и точный confirmed prefix; ничего не снимать/не удалять для косметического rollback.
3. Unknown/partial cleanup →typed8 с конкретным error code, safe next_action и evidence. Доказанный spawn failure до старта команды можно отдельно классифицировать по C03, но требуется конкретный emergency outcome, а не unexpected_error. Не логировать секреты/нефильтрованный stdout/stderr.
4. Сделай результат частичной операции машинно проверяемым: какие ресурсы attempted, какие confirmed stopped, где осталось unknown и существует ли durable PAUSED. Используй существующие допустимые envelope/data/error расширения, не ломай CONTRACT1.0.0. Не объявлять attempted ID подтверждённым только из exit0 без postcondition.
5. Next action должен вести к проверке остаточных ресурсов/manual recovery, не к автоматическому повторению stop или новой plan/apply мутации. Не добавлять retries, которые могут повторить действие с неизвестным результатом.
6. Введи failures на PAUSED temp write, file fsync, rename и parent fsync; до admission root/foreign/raw sudo остаются commands0 и без неавторизованного PAUSED. Различай «старый PAUSED сохранён», «новый опубликован, durability unknown», «публикация не произошла».
7. Trusted missing-status case создавай **до genuine S05 publication**, чтобы его отказ достигал `emergency_postcondition_missing`, а не раннего manifest-proof drift. Аналогично проверяй, что exception/postcondition hooks действительно достигнуты.

Reviewer desired oracle для thrown stop использует безопасный outcome8. Если выбираешь обоснованный typed6 для доказанного not-started ENOENT, сохрани original oracle/raw red и добавь узкий mapped predicate, который требует доказанный not-started, retained PAUSED/evidence, zero target effects и правильный next_action. Это не разрешение ослабить partial/unknown case: **после подтверждённого prefix + unknown следующего inspect нужен8 с сохранённым prefix**. Объясни соответствие C03; в сомнительном случае выбери консервативный8.

## 6. R31-F04 — явная test identity во всех current-source callers

1. Пройдись по всем вызовам `requestCancel`, включая TS tests/helpers, generated child code и standalone JS runners. Current-source caller должен передавать тот же ProcessAdapter, которым создан actual test engine/run. Не выдумывать pid/start/boot из ожидаемого результата.
2. Предпочтительный вариант — обязательный ProcessAdapter во внутреннем API. Убери fallback-предположение, что omitted adapter означает правильного пользователя. Public CLI/config не меняются. Если оставляешь совместимость, чётко обоснуй безопасную границу; mixed real/fake identity в tests недопустима.
3. Важные текущие места: `setup/tests/helpers/r211-access.ts`, `setup/tests/integration/q1a-r22-context.test.ts`, `setup/tests/integration/core-q1a.test.ts`; external `access-continuation-probes.cjs` и `r3-adapted-probes.cjs`. Reviewer patches показывают минимальный объём, но проверь остальные callers.
4. Historical runners, исполняющие genuine old engine, сохраняются неизменными. Для new engine нужен отдельный transparent compatibility runner; не переписывать исторические inputs и не выдавать их за исходные bytes.
5. Не отключать root/ordinary-owner assertions, не monkeypatch `process.getuid()`, не устанавливать фиктивную global identity, не менять FS metadata checks. Actual UID и injected application UID записываются раздельно.
6. Итоговые tests должны быть переносимы между обычной development UID и root-owned isolated test container. Это не означает разрешения запуска production CLI под root. Если одна реальная среда недоступна, честно NOT RUN, а fixtures проектируются без условного host-UID bypass. Не требовать sudo или изменения пользователя на машине владельца.

## 7. Матрица приёмки R3.1

| ID | Условие |
|---|---|
| A31-01 | Original14 baseline complete/7 desired red сохранён; все hooks достигнуты; oracle отдельно от collector exit |
| A31-02 | Invalid schema2/unknown version →typed8, S02 calls/events0, request/evidence сохранены |
| A31-03 | Valid matching→130/0effects; valid stale/recognised legacy не отменяют следующий run; no-cancel→1/1/1 |
| A31-04 | Atomic cancel/generation races, prefix/no-replay и R221 final context fence сохранены |
| A31-05 | Missing/empty/stale advisory inventory не скрывает same known live owned workload |
| A31-06 | Live empty подтверждается отдельно; unknown daemon/ownership/output не становится empty/foreign |
| A31-07 | Own stop+postcondition работает; foreign untouched; никакого arbitrary sudo/shell/label/ID dispatch |
| A31-08 | Returned и rejected failures покрыты; partial/unknown→8 с confirmed prefix, PAUSED и понятным recovery action |
| A31-09 | PAUSED publication failure windows сохраняют фактический исход; trusted missing-status branch действительно достигнут |
| A31-10 | Current-source tests/runners используют explicit matching adapter; root/foreign CLI negative controls не ослаблены |
| A31-11 | Полный setup suite на final bytes без removed/skipped assertions; старые589 сценариев сохранены либо каждое изменение mapping обосновано |
| A31-12 | R3 original/mapped14; R221 boundary14/context5; S03/genuine v1/genuine v2 по13; O01 честный8+fresh review/no-replay; frozen/command/R2 contracts complete |
| A31-13 | Все matrices exact-ID complete; no splicing; O02 historical cause не закрыта без evidence |
| A31-14 | Final tested sources/runners = manifest = реконструкция; исходные owner changes/index сохранены после полной capture |

Отчёт содержит PASS/PARTIAL/FAIL/INCOMPLETE/NOT RUN для каждого ID. Негативные тесты не должны проходить лишь потому, что любая операция заблокирована: positive counterpart обязателен. Проверяй точные codes, actual counters, durable files/receipts, ownership и complete matrix IDs.

## 8. Валидация без случайных повторов

На final source bytes: Node24; `npm --prefix setup ci --ignore-scripts --no-audit --no-fund` в owned test snapshot; typecheck; полный test; новые desired probes и перечисленные inherited matrices с completeness checks. Не трогай dependencies владельца в чужой рабочей копии. Никаких real privileged/live calls.

Нужен **один полный итоговый run после известных исправлений fixture identity**, с собственным ledger от начала до конца. Сначала targeted tests на исправления; не прогоняй весь suite после каждой строки. Все предыдущие failures сохраняются как отдельные attempts.

Если runner incomplete, немедленно классифицируй по raw evidence; разрешена одна целевая instrumented попытка первого необъяснённого incomplete runner. Не делай keepalive, не увеличивай timeout ради green и не склеивай частичные результаты. При доказанной причине и реальном исправлении допустим новый полный run на новых bytes, с честным номером попытки. Оставшаяся неизвестность не выдаётся за успех.

Frozen33/command37/R2-checker39 пересекаются. O01/C01 original auto-success остаются historical known-red; current honest-recovery mapping уже принят и не требует возвращения recover0. Genuine v1/v2 используют настоящие old state/journal/receipts, а current FS API bridge — отдельный документированный слой.

Проверяй source hashes до/после; hashes manifests должны включать реально исполняемые external runner/fixture inputs. Если создаёшь mapped runner, добавь его в tested inputs. Не засчитывай original checksum, когда исполнялся изменённый файл.

## 9. Границы задачи

Не переписывай работающий protocol mutex и review model, не вводи авто-reclaim, не восстанавливай prepared approval, не делай unpause. Не начинай весь process supervisor, реальную SSH/UFW rollback систему, narrow sudo executor, Docker host installation, OAuth/live/backup/restore/update или M0/M1/M2 features. Root/hostile filesystem isolation и реальные deadlines/process-tree cleanup остаются последующими этапами.

Новые public capabilities/commands приложения не изобретать. Текущий M0 без status postcondition не становится confirmed-stop от изменения одного документа. Service unsupported остаётся typed5. Ограниченный fail-closed path допустим там, где capability действительно отсутствует, но не использовать его для подмены required trusted positive tests.

Не обновляй pins/dependencies/checksums «заодно». Устрани противоречия только в затронутых документах: semantic-invalid cancel, advisory inventory, partial emergency, actual/injected identity. Разделяй local logic verification и production qualification. Код затронутых security branches сделай читаемым, без массового форматирования repository.

## 10. Локальные артефакты и финальный ответ

Подготовь:

1. `docs/audits/remediation-q1a-r3-1-<actual-date>.md`: исходные/final identities, changed files, четыре исправления, A31 matrix, actual commands/results, attempts, O01/O02, NOT RUN, остающиеся границы.
2. `audit/evidence/q1a-r3-1-<actual-date>-local/full-local.patch`: полный воспроизводимый diff от named base, новые/binary/deleted files включены; owner layer и agent delta различимы. **Без index/staging.**
3. `tested-files.sha256`: все реально использованные source/config/schema/package/test/runner inputs, не только изменённые файлы.
4. `evidence.zip` и `evidence.zip.sha256`: оригинальные/новые/mapped runners, exact input hashes, raw outputs, exit/signal/duration/cwd/Node/npm/actual UID, predicates/completeness, reconstruction и README.

Проверь реконструкцию один раз в обычном чистом directory snapshot. Full patch применяется один раз; альтернативные split patches не накладываются дополнительно. Не создавать рекурсивный архив старых ZIP, node_modules/dist, всего repository или temp trees. Исключай generated seal metadata из самоссылочного payload; явно документируй exclusions. Не удаляй owner pyc/untracked files ради чистоты.

Финальный ответ: закрыто/частично/открыто по четырём findings, фактические tests и NOT RUN, пути пяти файлов. Единственное действие владельца — передать их reviewer; не просить privileged run, production VPS или credentials для завершения этого задания.

**Ещё раз: без commits/push/branches/worktree/PR/index/merge/tag/release/deploy; все изменения локально. Сохрани запрет и в любых следующих AI-промптах.**
