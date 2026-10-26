# Copilot — Q1A-R2.2: C13 plan и доказуемый контекст разрешения

## 0. Назначенная задача и запреты

Выполни **только Q1A-R2.2** по аудиту `reviews/agent-factory-r211-audit-117a71e.ru.md`: приведи plan serialization и admission к CONTRACT C09/C13, закрой R22-F01/F02/F03. Нужны локальный рабочий код, meaningful regression proofs, согласованные schemas/docs и воспроизводимый evidence package. R21-F01/F02 приняты в локальном scope; не начинай очередной S03 micro-pass без нового доказанного регресса.

**НЕ делай коммиты. НЕ пушь. НЕ создавай ветки, worktree или PR. НЕ выполняй merge/tag/release/deploy. НЕ используй staging/index для упаковки, включая `git add -N`. Все изменения остаются локально. Эти запреты обязательно сохранять во всех следующих генерируемых промптах для ИИ-агентов.** Публикация — отдельное действие владельца.

Сохрани исходный staged/unstaged/new-file owner layer и dependencies. Запрещены reset/clean/stash ради чистого дерева. Начни с read-only HEAD/tree/branch/status/diff и checksum index. Для baseline/reconstruction — обычные временные archive-копии без веток/worktree/staging.

Разрешены безопасные локальные tests с injected adapters, owned temporary FS и harmless owned child processes. Не выполнять реальные sudo/APT/systemd/SSH/UFW/Docker-daemon, OAuth/model/provider/GitHub writes, не использовать credentials, не создавать VM/VPS, не публиковать release. Никаких `sudo node`, NOPASSWD, root broker, chmod666 сокета, global `--yes` или автоматического approval.

Прочитай AGENTS.md, этот промпт, новый аудит, report R2.1.1, `setup/docs/{plan-admission-r21,access-continuation-r211,privileges}.md`, CONTRACT C05–C13 и релевантный execution-plan. Это явно назначенный cross-cutting remediation: schema/types/core/gates/stage-producers/test fixtures/docs можно менять в необходимом объёме. Нормативный CONTRACT 1.0.0 не ослаблять. Несоответствие нынешнего implementation C13 не является разрешением переписать CONTRACT под текущий код.

## 1. Точная база и сохранённые гарантии

Reviewed master: **`117a71e3607659e97509b99c1662131c3970c112`**, tree **`1f7a683b1f0a3ccb97443d2161febaa405337a07`**. Incoming R2.1.1 base: `6281df5796ec5dd82a6fee95b058bbc970f0ed16`. Manifest148 SHA-256: `0665810884ee2a558be71467723b4b3818ca21c47d06b5296479ec81803f18c0`.

Если actual HEAD иной, зафиксируй delta и actual base; не выдавай указанный SHA за реально протестированный. Audit-only delta допустим после побайтной проверки relevant inputs. Если владелец изменил product source, учти эту работу отдельно и не затри её.

Независимый reviewer получил 446/446 tests, S03 original13/13, genuine baseline→fixed13/13 и frozen33/command37/R2checker39 PASS. Не складывай перекрывающиеся assertions. Сохрани trusted producer policy, строгий TTL, immutable request admission, exact operation bindings, S03 proven-prefix/no-replay, Docker manual-session progress, S05 checked absolute command entries, SSH policy B, unknown-effect/recovery/crash guards. Старый gate-stripping + recomputed self-hash должен по-прежнему блокироваться до effect.

## 2. Доказанные исходные counterexamples

В reviewer ZIP: `evidence/context-binding-probes.cjs` и `check-context-binding.py`. Реальные SetupEngine/S02; S01 prerequisite — noop, APT и process identity injected. State/plan/approvals публикует engine. Нет реальных host mutations.

| ID | Изменение после настоящего plan/approve | Сейчас | Требуемо |
|---|---|---|---|
| B01 | Нет, новый engine instance | exit0, refresh/simulate/install=1/1/1 | Положительный контроль продолжает работать |
| B02 | Только machine hash | exit0, counts1/1/1 | Foreign-host refusal до intent/effects |
| B03 | Только boot UUID, прежние approvals | exit0, counts1/1/1 | Fresh session/revalidation/review, старое approval не разрешает effect |
| B04 | Docker CE pin в существующем versions.lock по тому же пути | exit0, counts1/1/1 | Stale-context refusal до intent/effects |
| B05 | Нет одобрений | exit4, counts0/0/0 | Сохранить отказ |

На master и actual prior base **2/5 desired PASS**, checker `--expect fixed` exit1. `--expect observed-current` проверяет исторический дефект, а не пригодность исправления. B04 не доказывает установку чужого Docker pin: его предмет — общий version-lock binding. B03 не означает, что boot_id должен стать foreign-host identity.

Учти R211-O02: combined reviewer replay остановился на неполных JSONL outputs при exit0. Отдельный полный comparison прошёл, но стабильность пока не доказана. Причина неизвестна; не приписывать её новому S03 коду без evidence. На своей среде проверяй полноту каждой матрицы и сохраняй incomplete runs; не повторяй до случайного green и не объявляй их PASS.

Сначала заморозь эти inputs и измерь baseline. Затем реализуй correction. Не менять expected counts, не подменять S02 synthetic stage и не использовать setup/import errors вместо meaningful red.

## 3. Сначала зафиксировать модель, затем реализовать её

Создай короткий `setup/docs/plan-context-r22.md`: нормативные поля → producer → persistent proof → admission check → failure/next_action. Опиши canonical hashing, owner-session identity, scope/target, migration, safe refusals. Документ должен соответствовать итоговому коду, а не быть альтернативной спецификацией.

Реализацию вести последовательно: typed context и C13 schema; trusted production/persistence; approval/apply/resume enforcement; migration/progress; tests/evidence. Это части одного задания, не разрешение остановиться после одного документа или без working consumer. Не вводи параллельный универсальный policy framework, второе хранилище состояния или general root executor.

## 4. C13 serialization, operation semantics и canonical identity

Согласуй `InstallerPlan`, schema, producer, consumer, CLI outputs, fixtures и docs с C13:

- `schema_version:1`, `installation_id`, `host_fingerprint`, `generated_at`, `expires_at`, `desired_hash`, `version_lock_hash`, `observations_hash`, `plan_hash`, `operations[]`.
- Operation: `operation_id`, `stage_id`, **закрытый enum конкретных adapter actions**, `resources[]`, `expected_before_hashes`, `expected_after`, `requires_gates[]`, `retry_policy`, `estimated_effects`, `unknown_effects[]`.
- Не терять нынешние security semantics: risk, exact stage/closure, gates, preconditions/constraints, effects, timeout, retry. Если нужны дополнительные поля, определить их явно в строгой schema и документировать совместимость; не разрешать произвольные unknown fields.
- `mutate/verify` само по себе не concrete adapter action. Определяй действие в trusted stage producer; не выводи его из присланной shell string или одного resource name. Unknown action никогда не исполняется. Применение использует закрытый registry/mapping, а не динамическую команду из JSON.
- Canonical JSON: рекурсивная сортировка object keys, значимый array order, hash без самого plan_hash. Strict field/type/size/date validation и duplicate/foreign operation rejection. Self-hash не является authorization.
- `generated_at`/`expires_at`: реальные canonical UTC timestamps, ровно 30 минут; future generation и `now >= expires_at` блокируются, также для gate-free plans. TTL не продлевается resume/recover/approve. Один injected clock. Уже начатый bounded APT action сначала достигает безопасной границы; истечение TTL блокирует следующее действие, а не слепо убивает dpkg.

Не оставляй старый `stages/created_at` формат фактическим execution source под декоративной C13 обёрткой. Внутренние StagePlan могут сохраняться, если преобразование однозначно и проверяется обеими сторонами. У flat operations должен остаться точный trusted stage closure, включая verify-only/no-op dependencies.

## 5. Trusted context: откуда берутся факты

Контекст получает installer из checked OS/adapters/artifacts, а не из submitted plan. Он должен быть связан с committed review, проверяться на gate approve, после получения installation lock и перед каждым следующим effect.

**Host.** Machine identity + фактический supported OS/arch и installation binding. Скопированный plan/state/approvals на другой machine не исполняется даже при тех же paths/config. Нет fallback вроде hash(`unknown-machine-id`) как доказательства. Проверка только в recover недостаточна. Не превращать missing identity в fresh installation.

**Owner/session.** Обычный configured owner, подтверждённые UID/identity, boot и стабильный OS-derived login/session identity. Определи supported Linux semantics и fail-closed fallback. Новые CLI-процессы одной owner session должны разделять допустимую identity; PID или random UUID на каждый process для этого непригодны. Новый login/boot invalidates прежнее approval. Не доверять arbitrary env/session ID и не создавать «вечный session token» в config. Если identity достоверно получить невозможно — typed blocker с точным действием владельца. Tests могут inject identity; production adapter должен реально её получать без sudo. Boot change требует revalidation и свежего review, не foreign-host error, не replay.

**Version lock.** Bounded read/validation actual reviewed file; content hash, не hash path и не переиспользованный state.lock_hash. Документируй, хешируются точные bytes или canonical validated JSON; последовательность должна быть одной для producer/consumer. Missing/invalid/truncated/symlink/substitution cases не дают placeholder hash. Чужое изменение того же пути invalidates старый review. Не обновляй package pins «заодно» и не выдумывай fingerprints/checksums.

**Release.** Bind declared release identity из config и фактический verified artifact/manifest/executable content для stages, которые используют release. Учти S05 trusted commands и S06 pinned inputs; digest/release-root/command substitution не должна получать прежнее approval. Для host-only stage scope не требуй выполнения или загрузки отсутствующего M0: явно опиши applicability и что доказано. Не выдавай hash строки пути за artifact proof. Read-only hashing больших artifacts — с bounded streaming/size/deadline; не выполнять build/package lifecycle во время admission.

**Observations.** Hash security-relevant projected facts, stable across serialization и process restart. Исключить timestamp и volatile metrics из desired identity, но контролировать relevant drift/preconditions. После подтверждённого собственного effect проверять доказанный frontier/expected transition, а не требовать прежний initial observations hash от уже изменённой машины. Не переписывать одобренный plan для «подгонки» под текущее состояние.

**Target/closure.** Preserve provenance default selected stages versus explicit `--stage`; authorize exact trusted transitive closure. Нельзя выдать subset/superset/reordered/foreign stage plan за ранее рассмотренный. Проверить и no-op prerequisite. Не принимать target исключительно из submitted JSON без binding с trusted producer review.

## 6. Gates и момент отказа

Bind approval к operation type/id, resources, host, owner session, config/plan и всему relevant context, expiry. Stage-wide gates не должны потерять scope при flattening operations. Никаких wildcard approval или автоматического переноса старого status=approved при замене hashes.

Gate approve сам проверяет ordinary owner, exact current producer review и context; недействительный plan нельзя одобрить в надежде, что apply позже откажет. Внешние prerequisites нельзя «удовлетворять» флагом approval: сохранить реальные probes и правила интерактивного cutover.

При контекстном отказе до effect: никаких target calls, intent, ложного applying/verified и потери receipts/checkpoints; known-progress evidence сохраняется. Отделить допустимую явную фиксацию invalidation/manual requirement от изменения единственного доказательства завершения. Для каждого пути определить и проверить это в tests. Read-only status/gate list не чинят и не перезаписывают историю.

Проверки request/context после lock и перед действиями должны использовать checked bytes/identity, а не позднее перечитывать непривязанный путь для исполнения. Добавь контролируемые race fixtures: config/plan/lock/release меняются между initial read и lock, между check и следующей effect admission. Зафиксируй честный предел OS-level TOCTOU proof; общий hash check не заменяет безопасные privileged filesystem operations Q2.

## 7. Migration и сохранение R2.1.1 progress

Эта задача меняет публичное представление plan; опиши legacy detection явно. Старый execution plan не становится C13-approved после автоматического пересчёта hashes. Для effects нужен свежий producer plan/review.

При этом **не терять confirmed progress**:

- Строгий legacy evidence reader может использовать exact old bound plan как историческое доказательство v1; он не является permissive execution parser.
- Genuine v1 и v2 S03 publications должны переноситься через явный новый review там, где equivalence доказана; новый catalog не повторяет install/stage/arm/cutover/tailnet/disarm.
- Original published operation/attempt/receipt/checkpoint identity сохраняется. Если representation/action enum меняется, нужна ограниченная документированная semantic mapping с отрицательными tests, а не сравнение только resource/name или удаление требований.
- Changed gates/resource/risk/constraints не наследуют approval. Неподдержанный/неоднозначный legacy proof блокируется с сохранением evidence, не стирается и не объявляется fresh.
- Новый процесс в той же session и при действующих new-format approvals продолжает известный remaining suffix без re-plan. После TTL/session change: explicit new review, проверенный перенос progress и новые approvals, без replay.
- S04 Docker group relogin остаётся реальным session boundary; после нового login нужны approvals remaining plan. S05 command identity checks не ослаблять для удобства migration.

**R211-O01 переносится в R3.** Successful S03 → no-op re-plan → primary loss → recover → resume сейчас даёт typed refusal, fresh explicit review →resume0 без replay. В R2.2 сохранить отказ при недоказанной review identity и работоспособный explicit-review путь; не «чинить» его auto-approval или доверием submitted JSON. Не требовать resume0 без доказательства. Оригинальный supplementary desired runner сохранить как known-red; новый переход new-format добавить отдельно с честным статусом.

## 8. Acceptance matrix — обязательная, без cosmetic green

| ID | Условие приёмки |
|---|---|
| A22-01 | C13 producer/schema/consumer round-trip; canonical hash; unknown/duplicate/foreign fields/actions/IDs, invalid dates и tampering отвергаются |
| A22-02 | B01–B05: новый desired oracle **5/5**; реальные engine/S02, fake только внешние effects/identity; baseline red сохранён |
| A22-03 | Same host/same session/new CLI PID — положительный; foreign machine/OS/arch/installation/missing identity — отказ до intent; никакой silent rebind |
| A22-04 | Same host/new boot или новый login — старые approvals invalid; fresh review/approval после revalidation позволяет безопасный remaining suffix |
| A22-05 | Version-lock same-path replacement/missing/invalid/truncated/unsafe link — отказ; fresh reviewed valid lock — положительный; content hash проверяется, не path hash |
| A22-06 | Relevant release archive/manifest/entry substitution — отказ; unchanged verified release — положительный; host-only scope не требует live M0 |
| A22-07 | Volatile observation timestamps не создают ложный drift; relevant external drift блокирует; собственные verified transitions сохраняют продолжение |
| A22-08 | Default и explicit target/closure; subset/superset/order/no-op prerequisite tampering не расширяют разрешение |
| A22-09 | Gate approve/apply/resume проверяют одинаковый context; root/wrong owner/session, wrong operation/resource/hash, expired gates не одобряются и не исполняются |
| A22-10 | TTL на 30min-1ms/ровно30min/после/future/invalid date, включая gate-free; clock advance внутри bounded action не даёт следующего effect |
| A22-11 | Original S03 13-case semantics и genuine legacy→new-format explicit-review переходы: каждый effect ровно один раз, включая arm/disarm shared resource |
| A22-12 | Отдельные процессы, несколько последовательных пауз, restart/re-plan/new session; durable prefix, TTL и new policy сохраняются без replay |
| A22-13 | Config/plan/lock/release swap при lock/admission; controlled concurrent writers; loser не публикует intent и не меняет known evidence |
| A22-14 | Metadata-only interruption и checkpoint/binding failures не создают authorization; malformed/foreign/incomplete metadata и unknown effects блокируются |
| A22-15 | S03 final recovery limitation видна; explicit reviewed workaround работает в новом формате без повторных effects; known-red oracle не подменён |
| A22-16 | Все прежние 446 test semantics, frozen33/command37/R2checker39 и S00…S07 composition, Docker relogin, S05 checked commands сохранены |
| A22-17 | Actual argv/cwd/exits/counts/PIDs/hashes и failure classifications; пустой/неполный runner output не считается PASS |
| A22-18 | Actual-base + owner layer + agent delta reconstructs полный tested tree; hashes до/после validation совпадают, отчёт соответствует файлам |

Не механически требовать прежнее число отдельных tests, если таблица или schema migration естественно меняет их организацию. Сохрани и отобрази каждый прежний смысловой assertion; никаких skipped/removed tests ради PASS. Harness exit0 не заменяет desired product assertions. Для safety-negative требовать нулевые counts, отсутствие нового intent и сохранённые evidence; добавить positive counterpart для отличия security refusal от сломанного happy path.

## 9. Frozen runners и допустимые адаптации

Входящие original runners/oracles сохранить байт-в-байт. C13 может менять fixture setup и чтение сериализованного plan: это допустимо только в **отдельном** named compatibility adapter/runner с таблицей изменений. Исходные functional assertions/counters/side-effect meanings не ослаблять.

Например, fixture может потребовать настоящую injected session identity и валидный локальный versions.lock, которых старый setup не требовал. Дополни такие inputs явно, не bypass admission. Если old runner читает `plan.stages`, adapter может читать новую schema, но не превращать отсутствующее evidence в success. Зафиксируй old-runner format failure отдельно от product failure; прогони неизменный продуктовый oracle над сопоставимыми rows. Для нового format нужны также собственные schema-native tests.

Сохрани baseline назначения: текущий117a71e — R2.2 baseline; historical ca6d0b6 — unsafe R2 baseline; b888082 — unsafe command identity; 6281df5 — genuine S03 v1 baseline. Нельзя менять baseline только потому, что ожидаемый red оказался неудобен. Старый input ZIP уже содержит необходимые runners и fixtures.

Запускай минимум locked `npm ci --ignore-scripts --no-audit --no-fund`, typecheck, полную suite и relevant independent matrices на обычной reconstructed copy. Проверяй каждый exit и shape/число результатов. Пустой лог при exit0 — harness failure, а не product PASS; сохраняй неудачный запуск и причину повторения.

## 10. Evidence package и отчёт

Создай локально:

1. `docs/audits/remediation-q1a-r2-2-YYYY-MM-DD.md`: verdict по каждому R22 finding и A22 row, изменённое поведение, точные evidence refs, известные ограничения, NOT RUN и следующий шаг.
2. `audit/evidence/q1a-r2-2-YYYY-MM-DD-local/`: actual base commit/tree; initial/final owner layer/status/index hashes; full-local.patch; отдельно agent-delta и owner layer при наличии; new-files payload/manifest и deletions; tested-files.sha256 всех relevant source/schema/tests/docs/config/locks/fixtures; raw logs и command ledger; unchanged original runners + явно описанные adapters; portable reconstruction/validation scripts.
3. `evidence.zip`, `evidence.zip.sha256`, внутренний SHA256SUMS. Report/manifest/patch внутри и рядом должны совпадать. Не менять тестированный код после packaging; иначе повторить affected validation и hashes.

Не положить zip внутрь самого себя, не включать node_modules/dist/Git metadata/secrets. Полный patch включает new files; если additions уже в patch, reconstruction не применяет new-files tar второй раз. Full reconstructed relevant tree должен совпасть с manifest, а не только несколько изменённых файлов. Не подменять actual tested tree ссылкой на HEAD при local delta. Указать Node/npm/OS/arch/UID и injected owner отдельно. VM/live checks честно NOT RUN.

Final response: что закрыто; что осталось; сколько meaningful tests/assertions реально прошло; filenames/checksums; точный следующий шаг владельцу. **LOCAL PASS** допустим только при выполнении назначенной матрицы и устранении R22-F01/F02/F03. Если осталось невыполненное требование, статус PARTIAL с конкретным blocker, без объявления production-ready. R211-O01, R3/Q1B/Q2–Q6 и полноценная application factory не закрываются этим пакетом.

После локальной упаковки завершить работу и предоставить результат на review. Не начинать следующий этап самостоятельно. Не коммитить, не пушить, не создавать ветки/worktree/PR.
