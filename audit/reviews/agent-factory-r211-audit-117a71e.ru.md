# agent-factory — независимый аудит Q1A-R2.1.1

26 октября 2026, Europe/Amsterdam. Проверенный commit: `117a71e3607659e97509b99c1662131c3970c112`.

**Решение: принять исправления R21-F01 и R21-F02 в локальном объёме R2.1.1 и перейти к R2.2. Production остаётся OPEN.** Обязательные продолжения S03 проходят без повторения effects; прежние защитные проверки сохранены. Дополнительный recovery-сценарий остаётся ограничением с ручным повторным review и переносится в R3. Это не безоговорочный PASS всего пакета: его исходный desired-oracle по-прежнему красный. Новый цикл R2.1.1.1 только ради автоматического `resume=0` сейчас не нужен.

Уверенность: соответствие исходников и измеренные результаты — **99%**; достаточность локальной приёмки двух исправлений — **90%**. Проверка не доказывает безопасность на реальном VPS и отсутствие всех возможных дефектов.

## 1. Что именно проверено

| Объект | Проверенное значение |
|---|---|
| Master commit | `117a71e3607659e97509b99c1662131c3970c112` |
| Tree | `1f7a683b1f0a3ccb97443d2161febaa405337a07` |
| Actual package base | `6281df5796ec5dd82a6fee95b058bbc970f0ed16` |
| Previous reviewed code | `d8728f56e847a9da75b9f21d8e6e6725a9bd295e` |
| Full patch SHA-256 | `1f9b6bac707441d84633eee78e33af9e6604bd621bcf7b17021263bbfd2cfdcf` |
| Tested manifest, 148 файлов | `0665810884ee2a558be71467723b4b3818ca21c47d06b5296479ec81803f18c0` |
| Входящий ZIP SHA-256 | `fc22ef3815a5db593baae8f047e5bf513be458f0fe6e93d82f515b48ee4e91ea` |

Все пять вложений побайтно совпали с опубликованным пакетом `../evidence/q1a-r2-1-1-2026-10-26-local`. Проверены ZIP CRC и 239 внутренних SHA-256. Реконструкция actual base + полный patch совпала с master по всем 148 setup-файлам; manifest покрывает все tracked setup inputs. Все 415 tracked файлов master совпали с экспортированным snapshot. После тестов исходники не изменились.

Между предыдущим reviewed commit и actual base — только четыре audit-файла; все 143 предыдущих setup inputs совпадают. Поэтому воспроизведение на actual base корректно. Относительно base изменены шесть production-файлов, два setup-документа и три test/helper-файла. `state.ts`, ProcessAdapter, S04/S05 и реальный privileged executor этим пакетом не исправлялись.

Проверка выполнена на Linux x86_64, Node **24.22.1**, npm **11.9.0**. Процесс проверяющего имеет UID0 в изолированной среде; installer fixtures используют injected owner UID1000. Это не запуск установщика с root-привилегиями на целевой машине и не qualification Ubuntu. Product source и исходный checkout не редактировались; использованы обычные archive-копии, без веток/worktree/staging.

## 2. Независимые результаты

| Проверка | Результат | Что доказывает |
|---|---|---|
| Locked dependency install с `--ignore-scripts`, typecheck | PASS | Исходники собираются в проверенной среде |
| Полная suite | **446/446**, fail/skip/cancel = 0 | Локальные assertions, включая новые 17 tests |
| Исходная S03 матрица на actual base | **3/13 desired PASS, 10 FAIL** | Старые дефекты действительно воспроизводятся |
| Та же неизменённая матрица на master | **13/13 PASS** | Resume/re-plan на шести границах; каждый effect ровно один раз |
| Genuine baseline engine publication → новый engine | **13/13 PASS** | Поддержанный переход с v1, а не только synthetic metadata |
| Две новые positive regression-матрицы поверх baseline | **0/2 PASS**, expected exit1 | Функциональный red: false drift и install=2, не ошибка импорта |
| Frozen / command identity / R2 assertions | **33 / 37 / 39 PASS** | Прежние ограничения и контрпримеры сохранены |
| Дополнительный S03 final recovery, baseline и master | **4/4 desired FAIL** | Ниже описано безопасное ограничение, не скрытый PASS |
| Новые context-binding probes, baseline и master | **2/5 desired PASS** на каждом | Три существующих пробела для R2.2 |

33/37/39 пересекаются: command37 включает агрегат frozen33, R2 checker включает служебные assertions. Эти числа нельзя складывать в 109 независимых сценариев. Baseline для S03 — 6281df5, для старых R2 counterexamples — ca6d0b6, для исторического command identity — b888082.

Проверен смысл новых тестов: отдельные Node-процессы и disk facts; последовательные паузы; TTL и новый review; own cutover с изменением трёх content hashes; external drift; подмена progress metadata; разные arm/disarm при общем resource; изменения gates/risk/resource/constraints; SIGKILL собственных дочерних процессов на трёх publication boundaries. Unknown effect не превращается в подтверждённый progress; после durable binding продолжение не повторяет install.

Оговорка о воспроизведении — **R211-O02, OPEN**. Первый comparison driver получил пустой `fixed-adapter-final.jsonl` при exit0; checker отказал из-за неполных 37 assertions. Он не засчитан. Два целевых повтора дали по пять ожидаемых JSONL-строк; полный отдельный повтор прошёл 33/37/39.

При проверке нового объединённого portable runner неполнота повторилась: historical baseline-stage выдал одну строку вместо пяти. После анализа выполнено одно явное продолжение с проверкой/rebuild prepared sources и отдельными логами; оно остановилось на отсутствующем C08 в frozen matrix. **Объединённый portable replay — INCOMPLETE**, а не PASS. Дальнейшие повторы до случайного зелёного результата не выполнялись. Все три неудачных comparison-запуска сохранены. Дополнительный чистый FS-контроль без product-кода завершился 5/5; этого недостаточно для установления причины. Неизвестно, связан ли дефект с runner, runtime или продуктовым async path.

Индивидуальные измерения и полный отдельный успешный comparison остаются фактическими результатами, но не доказывают стабильность воспроизведения. Неполный вывод наблюдался и на historical baseline, поэтому считать его новым регрессом S03 нельзя. Перед приёмкой R2.2 нужно получить полные independently checked outputs на его среде; устойчивость процесса/runner диагностировать отдельно, при необходимости в Q1B. Ни exit0, ни запуск одного checker над пустой матрицей не считать PASS.

## 3. Почему R21-F01/F02 можно закрыть

**R21-F01 — CLOSED local.** Новый `core/progress.ts` восстанавливает точный подтверждённый prefix и его frontier до preliminary admission, выполнения и явного planning. Для frontier нужны stage/config/operation/resource/attempt/receipt hash, journal binding и checkpoint state hash. Затем S03 проверяет актуальные postconditions. Обычный resume использует подтверждённого предшественника вместо исходного pre-install observation.

**R21-F02 — CLOSED local.** При явном новом plan переносится семантически эквивалентный подтверждённый prefix, а не произвольные receipts по имени resource. Неизменяемая опубликованная операция хранится отдельно от нового observation-derived ID. Полное сравнение сохраняет risk, gates, constraints, effects, timeout и retry. Новые approvals не наследуются. Partial verified observation не стирает оставшуюся orchestration; final no-op сохраняет историю.

Ключевые места: `../../setup/src/core/progress.ts` (`restoreOperationProgress`, `carryOperationProgress`), `core/policy.ts` (`PublishedOperation`, строгий parser), `core/engine.ts` (admission и публикация progress), `stages/access.ts` (`verifyProgress`, `progressPolicyPlan`, staged content proof). Нормализация ограничена ID/observation hash и допустимыми public-exposure изменениями после доказанного cutover. Это существенно лучше broad normalization или reset completed state.

Остаётся сложность сопровождения: v1/v2 metadata, original IDs и aliases, public catalog и исторический catalog требуют совместной проверки. Сейчас это обоснованная совместимость, но будущий C13 refactor не должен развести эти представления. Internal key по-прежнему называется `setup_policy_basis_v1`, хотя принимает v2; это документировано, само по себе не security defect.

Legacy без reviewed source, с потерянным exact bound plan или пустым completion prefix при retained publications блокируется. Это явно допустимое ограничение этой задачи; удаление evidence ради «чистой установки» недопустимо.

## 4. R211-O01 — final recovery требует повторного review

**Статус: OPEN, существовавшее ограничение recovery; следующий владелец — R3. Не новый security bypass.**

Воспроизведение на baseline и master: успешный S03 → явный no-op plan/review → удаление только primary state в собственной fixture → `recover` → повторный `recover` → `resume`. В direct и plan-first ветвях: recovery0, repeat0, resume2 `plan_policy_mismatch`. После явного нового plan/review resume0. Счётчики install/stage/arm/cutover/tailnet/disarm остаются **1/1/1/1/1/1**, rollback0; effect checkpoint сохранён.

Причина: восстановленная generation может содержать прежний reviewed source, тогда как лежащий на диске plan относится к более позднему metadata-only review. Одного self-hash submitted JSON недостаточно для восстановления утраченного разрешения. Отказ сохраняет границу trusted policy.

Что сделать в R3: определить и документировать recovery/review reconciliation. Либо сохранить и доказать точную исходную review identity в durable recovery metadata, либо выдавать однозначный typed результат «требуется новый review» с рабочим `next_action`. В обоих случаях preserve receipts/checkpoints, никаких повторных effects, auto-approval или доверия новому plan только потому, что его hash пересчитан. Проверить обе ветви и explicit-review workaround после C13 migration.

Исходный `access-final-recovery.cjs` с требованием автоматического resume0 сохранён без правки и остаётся red. Решение о переносе ограничения — отдельная оценка scope, не изменение этого oracle задним числом. Copilot обоснованно не объявил общий recovery PASS; его маркировка PARTIAL прозрачна. Для продвижения проекта достаточно принять два назначенных исправления и явно оставить этот остаток открытым.

## 5. Следующее исправление: R2.2, контекст разрешения запуска

Следующие замечания **не введены R2.1.1**: production paths не менялись, и одинаковые результаты измерены на actual base. Они конкретизируют ранее открытый backlog.

### R22-F01 — план и одобрения переживают смену host/boot

**P1, OPEN.** `context-binding-probes.cjs`, B02/B03. Настоящий SetupEngine и S02, noop prerequisite S01, injected host facts и APT adapter. Создаются реальный plan и approvals; config/plan/state не подделываются. Между plan и новым apply меняется только injected machine hash либо boot UUID, время остаётся внутри TTL.

Фактически обе ветви дают **exit0**, S02 verified, refresh/simulate/install = **1/1/1**. Same-context positive проходит; unapproved negative даёт exit4 и нулевые counts. Это доказательство отсутствия общей привязки разрешения; оно не является эксплуатацией реального sudo или физическим переносом VPS.

В ordinary apply state host identity не сверяется с текущим machine identity. Проверка `assertRecoveryCandidateTrusted` в `core/engine.ts` защищает отдельный recovery path, но не обычное применение плана. Gate record содержит только id, operation_id, plan_hash, expires_at и status; owner session в нём отсутствует. Boot change нельзя объявлять foreign host — C07 требует revalidation. При этом прежняя owner session закончилась, поэтому старое sudo/cutover approval не должно автоматически разрешать новые effects.

Исправление: единый trusted context для planning, approval и каждой effect admission; distinct host identity и session/boot freshness. Fresh CLI PID в той же owner session должен работать; новый login/boot требует нового review/approval. Нельзя использовать random session UUID на каждый engine instance или доверять `--session-id` из JSON/env без проверки OS identity. Обычный владелец и достоверный host обязательны.

### R22-F02 — version lock связан путём, но не содержимым

**P1, OPEN.** B04: в owned fixture записан полный repository `versions.lock.json`; после plan/approve изменён только Docker CE pin по прежнему пути. Config hash и plan bytes не изменились. Новый S02 apply даёт exit0 и counts1/1/1. В этом сценарии не доказана установка изменённого Docker pin: S02 использует fake APT. Доказан более узкий факт — C13 global context binding не отказывает при изменении reviewed version lock.

`hashConfig` охватывает `version_lock_path`, не bytes файла. `state.lock_hash` — hash installation state path, не content hash versions lock. В `InstallerPlan`/schema нет `version_lock_hash`. Наличие локальных pin checks в отдельных stages не заменяет общий plan binding.

Исправление: bounded read и валидация lock, воспроизводимый content identity, включение в trusted review и проверки при approval/после lock/до effects. Same-path substitution, missing/truncated/невалидный lock должны блокировать до intent. Legitimate смена lock требует свежего review; нельзя придумывать хеши или подставлять fallback.

### R22-F03 — C13 serialization и единый context ещё не реализованы

**P1 для общей границы admission, OPEN; static evidence.** Текущий `../../setup/schemas/plan.schema.json` сериализует `created_at` и `stages`; C13 требует `host_fingerprint`, `generated_at`, `expires_at`, `version_lock_hash`, `observations_hash`, `operations` и конкретные operation kinds/resources/expected hashes/retry/effects. Текущий строгий 30-minute TTL работает — замечание не о его отсутствии.

Нужны согласованные schema/types/producer/consumer/persisted approvals/docs, release identity, significant observations, explicit target/closure provenance, и правила legacy migration. Хеш submitted plan сам по себе не является authorization. Сохранять proven progress и блокировать неизвестное; не выполнять старый plan через permissive compatibility parser. Конкретное ТЗ и acceptance matrix — в приложенном промпте R2.2.

## 6. Что остаётся до production

| Блок | Ожидаемый результат |
|---|---|
| **R2.2 — следующий** | C13 и проверяемая связь разрешения с host/session/lock/release/observations/target; отрицательные substitution/race cases |
| R3 | Остальные cancel/lock/concurrency/cleanup и recovery semantics, включая R211-O01 |
| Q1B | Process supervisor: descendants, bounded I/O/timeouts, env/cwd/stdin, supported host checks |
| Q2 | Реальная узкая sudo-модель, safe root-owned writes, APT provenance, SSH/UFW cutover/timer/rollback, Docker safety |
| Q3 | Доверенный packaged M0, release/lock/bootstrap и полный offline S00…S07 |
| Q4 | Auth/secrets, budgets/live admission, backup/restore; отдельный разрешённый live smoke |
| Q5, optional | Service/unattended/update/inference/platforms со своими M1/M2 prerequisites |
| Q6 | Qualification конкретного release на Ubuntu 24.04 amd64: clean/repeat/reboot/failure/recovery matrix |

У реального `NodeAccessAdapter.applyCutover` по-прежнему нет реализации cutover; arm/disarm/rollback записывают markers (`stages/access.ts`, конец файла). Это **незавершённый код Q2**, не просто отсутствие VM-теста. S04 privileged staging и остальные прежние AF blockers также не получают PASS от текущих tests.

Этот маршрут доводит до production выбранный профиль **развёртывания**, а не всю прикладную фабрику. M0 пересекается с этим маршрутом как prerequisite. Полноценная фабрика, orchestration/agents и service capabilities требуют собственного развития и аудита. Ранее обсуждавшиеся 12–20 циклов были ориентиром для оставшегося installer backlog, а не обещанием срока для всей фабрики; этот review не даёт оснований для более точной оценки.

## 7. Действия владельца

1. Передать Copilot `../copilot-q1a-r2-2-task.ru.md`, этот аудит и reviewer evidence ZIP. ZIP нужен для неизменённых runners/oracles и baseline proofs.
2. Выполнить только локальный R2.2. В промпте запрещены commit/push/ветки/worktree/PR и публикация; текущую публикацию владельцем не считать нарушением прошлого задания.
3. Прислать отчёт, full patch, tested-files manifest и evidence ZIP с checksum. Публиковать в master для следующей проверки не обязательно: при корректном base+patch пакет воспроизводим локально.

На этом шаге от владельца не нужны VPS, sudo-настройки, OAuth или реальные credentials. Для production/live использования разрешения ещё нет. Нельзя запускать privileged paths ради получения зелёного отчёта.

## 8. Evidence и ограничения

`evidence/identity-verification.json` — exact input/source identity; `validation/` — suite; `access-*` — исходные S03 matrices; `regression-baseline/` — meaningful red; `comparisons-rerun/` — окончательные старые guards; `recovery-*` — четыре supplementary failures и workaround; `context-*` — новые R2.2 measurements; `source-diff.patch` — reviewed diff; `portable-replay/` — успешные ранние шаги и остановленный неполный combined replay (не PASS). `incoming/` сохранён без изменений. `../../README.md` объясняет воспроизведение.

NOT RUN: реальные sudo/APT/systemd/SSH/UFW/Docker daemon, physical reboot/power loss, disposable VM suite, OAuth/secret exposure/model/provider calls, GitHub writes, release/deploy. Не проверялась криптографическая защита от самого owner, меняющего trusted installer. Checksums подтверждают bytes, но не правильность алгоритма. Локальный safety proof ограничен проверенными entry points и fixtures.
