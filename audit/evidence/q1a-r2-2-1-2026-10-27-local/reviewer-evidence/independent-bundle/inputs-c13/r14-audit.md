# Agent Factory: независимая проверка Q1A-R1.4

Дата итогового отчёта: 25 октября 2026 (Europe/Amsterdam). Проверяемое обновление от 24 октября; master: `2eb026527d3448fc0d455f6fe8713cba61c0d3c5`.

**Вердикт: R1.4 — PARTIAL. Основные исправления recovery подтверждены; пакет пока не принимается целиком из-за трёх конкретных пробелов в S03/S04/S05. Production — OPEN. Следующая работа — локальный R1.5 по приложенному ТЗ.**

Это проверка обновления относительно предыдущего аудита R1.3, а не заявление, что остальные AF-01…AF-31 повторно проверены и закрыты. Код продукта при аудите не изменялся. Коммиты, push, ветки и PR не создавались.

## 1. Что именно проверено

| Объект | Идентификатор / результат |
|---|---|
| Предыдущий аудит | `3e4e07c4ec4bf5ca898025b68520c43c5d9905e3` |
| Code commit из отчёта Copilot | `4c28f49228a01a0cb4e8f25a7504883c90ea8672` |
| Его tree | `62e71f3d7585493602af88b5861eb21d00b35c66` |
| Проверенный master | `2eb026527d3448fc0d455f6fe8713cba61c0d3c5` |
| Tree master | `5db7df2b8f313e9213f524f217772e5aad6d398a` |
| Разница code commit → master | Только отчёт, ZIP evidence и его checksum; код одинаков |
| Входной ZIP | `agent-factory-q1a-r1-4-evidence-2026-10-24.zip` |
| SHA-256 входного ZIP | `bd0bee8b8798e0cec3b26a4658b22f61f6e1a18a5a72c9a5f640a3716d14dae4` |
| Входные материалы | Приложенные report/ZIP совпадают с файлами master; CRC ZIP и все внутренние SHA256SUMS проверены |
| Независимая среда | Linux x86_64, Node `v24.22.1`, npm `11.9.0`; чистый экспорт `git archive` master |

Версия Node в моём прогоне отличается от Node 24.12.0 в отчёте Copilot. Это дополнительный прогон на Node 24, а не повторение побайтно идентичной среды Copilot. Remote master повторно проверен перед подготовкой результатов: тот же SHA.

Просмотрены изменения всех девяти production-модулей, четырёх integration test-файлов, новых test helpers, lifecycle/privilege/inventory docs и evidence. Оригинальная рабочая копия и её посторонние файлы сохранены. Переходов на другую ветку и изменения index не было.

## 2. Подтверждённые улучшения и валидация

| Проверка | Независимый результат | Что именно доказывает |
|---|---|---|
| `npm --prefix setup ci --ignore-scripts --no-audit --no-fund` | exit 0 | Зависимости устанавливаются из lockfile без lifecycle scripts |
| `npm --prefix setup run typecheck --silent` | exit 0 | TypeScript проходит |
| `npm --prefix setup run test --silent` | **254 passed, 0 failed, 0 skipped** | Текущий набор локальных тестов проходит |
| C01…C12 из R1.4 comparison runner | Все сценарии измерены; ожидаемые исправленные результаты подтверждены | Прежние конкретные контрпримеры воспроизведены на новом коде |
| S00/S01, S02 lifecycle | apply/status/resume/repeat успешны в соответствующих fixtures | Настоящий engine и producer-модули, подставные внешние операции |
| S03/S04/S05/S07 stage compatibility, S06 no-op | PASS | Совместимость producer-модулей с пооперационным engine |
| Полная композиция S00…S07 | apply/status/resume = 0 | Fixture с уже существующим синтетическим M0 checkout и активной Docker group; настоящие stage-модули |
| U05 | 56 тестов | Противоречия evidence в четырёх состояниях recovery |
| U07 | 36 записей `R14_FAULT` | 3 фазы manifest × 4 I/O границы × before/after/control |
| U04/U08 | 10 записей `R14_CRASH` | Настоящие дочерние процессы, IPC, SIGKILL и restart с подставными host-effects |
| Recovery fault controls | 4 записи `R14_RECOVERY_FAULT` | Прерывания восстановления engine-generated clean proof |

Числа матриц выше относятся к тому же прогону 254 тестов, не к дополнительным независимым сотням проверок. Наличие реальных child-процессов не доказывает поведение реального apt/systemd или сохранность при отключении питания.

Теперь действительно работают:

- восстановление после `apply → plan → потеря primary`, напрямую и после marker, без потери checkpoint/progress proof;
- отказ при quarantine даже с корректным primary, и отказ при конфликте prepared decision **до изменения** evidence;
- привязка receipt к journal и checkpoint, сохранение завершённых операций S02 перед поздней ошибкой;
- отказ до intent при обнаруженном S03 drift;
- обязательные S05 command probes в обычном apply и ошибочный результат при их отказе;
- durable manual pause после обновления Docker group в исходном C07 fixture;
- отказ в публикации ложного `verified` при проверенных I/O fault-сценариях финального commit metadata.

В отчёте теперь честно указан отдельный **code blocker**: `NodeAccessAdapter.applyCutover()` ничего не меняет, а rollback/timer реализованы маркерами. Это существенное улучшение точности отчёта: реальная реализация ещё нужна, одной VM-проверки недостаточно.

## 3. Новые и незакрытые замечания

Все три требуют исправления до приёмки текущего пакета. P1 здесь означает блокер безопасности/работоспособности поддерживаемого пути; это не утверждение о реально совершённой атаке.

### R14-F01 — P1: S05 запускает код после обнаруженного нарушения целостности

**Подтверждённый факт, уверенность 100% для локального контрпримера.**

В `observe()` и `verify()` после `verifyContentHashes()` безусловно вызывается `probeCommands()`. Проверка `mismatches.length` влияет на результат только **после** запуска команд. Production adapter исполняет указанные в manifest команды с `--help`; наличие этого аргумента не делает чужой код безопасным.

Источники: [application.ts:337](https://github.com/se-panfilov/agent-factory/blob/2eb026527d3448fc0d455f6fe8713cba61c0d3c5/setup/src/stages/application.ts#L337), [application.ts:623](https://github.com/se-panfilov/agent-factory/blob/2eb026527d3448fc0d455f6fe8713cba61c0d3c5/setup/src/stages/application.ts#L623), [git.ts:491](https://github.com/se-panfilov/agent-factory/blob/2eb026527d3448fc0d455f6fe8713cba61c0d3c5/setup/src/adapters/git.ts#L491).

Независимый сценарий сначала успешно развёртывает S05 через engine, с настоящим journal-bound receipt. Затем adapter сообщает `runner.js:hash-mismatch`. Каждый следующий вызов проверяется на отдельном fixture:

| Команда | Результат | Probe calls после известного mismatch |
|---|---|---:|
| `plan` | exit 0 | **1** |
| `verify` | exit 5, `s05_runner_probe_failed` | **1** |
| `status --refresh` | exit 8, drifted | **1** |

Ожидается **0** во всех трёх случаях. При `plan` persisted status остаётся `verified`; это записанный старый статус, а не доказательство новой успешной проверки. Отдельным finding этот нюанс не считается: основной дефект — уже состоявшийся вызов executable после отказа integrity check.

**Риск / вывод, уверенность 98%:** изменённый checkout может исполняться от имени owner во время диагностической команды. Исторический receipt доказывает прошлое развёртывание, не текущие байты файлов. У owner с Docker group потенциальный ущерб особенно высок; исполнение от root этим тестом не проверялось и не утверждается.

**Исправление:** запретить вызов executable при любой ошибке integrity/ownership/trust check; проверять текущий checkout непосредственно перед command probe во всех entrypoints, включая отдельную probe-операцию apply. Различать отказ целостности и неуспешный запуск корректного проверенного приложения. Сохранить положительные проверки, доказывающие, что probes действительно вызываются на исправном release. Не «исправлять» удалением probes или принятием старого receipt за актуальную проверку.

Evidence: `new-probes.jsonl`, N01; воспроизводитель `r14-new-probes.cjs` и frozen fixtures.

### R14-F02 — P1: новая установка Docker по-прежнему не доходит до штатного relogin

**Подтверждённый факт в engine и actual adapter contract control; уверенность 99% в причинной связи. Реальный VPS не использовался.**

Порядок S04: install → log-config → daemon restart → group membership → resource probe. Новый `verifyOperation()` для `docker-daemon-service` требует `daemonReachable && apiCompatible` **до** group operation. `NodeDockerAdapter.observe()` получает эти данные через обычные `/usr/bin/docker info/version`, без sudo.

Источники: [docker stage:519](https://github.com/se-panfilov/agent-factory/blob/2eb026527d3448fc0d455f6fe8713cba61c0d3c5/setup/src/stages/docker.ts#L519), [docker stage:719](https://github.com/se-panfilov/agent-factory/blob/2eb026527d3448fc0d455f6fe8713cba61c0d3c5/setup/src/stages/docker.ts#L719), [docker adapter:487](https://github.com/se-panfilov/agent-factory/blob/2eb026527d3448fc0d455f6fe8713cba61c0d3c5/setup/src/adapters/docker.ts#L487).

Для owner без активной группы `docker` защищённый root:docker socket не доступен. Официальная [документация Docker](https://docs.docker.com/engine/install/linux-postinstall/) описывает необходимость membership и нового login для его активации. Добавление пользователя в account database само по себе не обновляет группы уже работающего процесса.

Контрпример N02 моделирует именно такую доступность:

- install = 1, restart = 1;
- **group update = 0**, resource probe = 0;
- apply = **8**, `s04_operation_postcondition_failed`;
- S04 = `interrupted`, in-flight остаётся на daemon restart; journal заканчивается `intent → effect` без verify/checkpoint.

Дополнительный N02a использует **настоящий `NodeDockerAdapter.observe()`** и перехватывает все process calls: permission denied от `docker info/version` действительно превращается в `daemonReachable=false`, `apiCompatible=false`. Это подтверждает, что контрпример не опирается на выдуманную модель adapter.

Почему текущий U06 зелёный: `FakeDockerAdapter.installPinnedPackages()` безусловно выставляет `daemonReachable=true` и `apiCompatible=true`, даже когда `currentUserInGroup=false`. Исходный C07 измерен верно, но этот fixture не покрывает обычный безопасный socket на свежем хосте.

**Исправление:** account membership и durable manual pause должны предшествовать операции, postcondition которой требует owner-доступа к daemon; runtime/API/resource checks выполнить после новой сессии. Допустима другая строгая модель раздельного подтверждения service и owner access, но нельзя заменять её постоянным `sudo docker`, разрешением socket всем или пропуском postconditions. После pause: in-flight null, завершённые эффекты подтверждены; old session не делает новых эффектов; new session продолжает без повторного install; неопределённый реальный restart failure не превращается в известный успех.

Evidence: N02/N02a. U06/C07 нужно расширить, а не удалить или ослабить.

### R14-F03 — P1: raw SSH input proof пропускает нестандартные Include

**Подтверждённый факт для production collector, уверенность 100%. Вывод о полноте SSH admission — 96%; реальный sshd/cutover не запускался.**

`observeAccessInputProof()` читает `/etc/ssh/sshd_config` и фиксированный `/etc/ssh/sshd_config.d`, но не разбирает `Include` и не отказывает при иных include-paths. Вложенные Include внутри стандартных drop-ins тоже не учитываются.

Источник: [access.ts:712](https://github.com/se-panfilov/agent-factory/blob/2eb026527d3448fc0d455f6fe8713cba61c0d3c5/setup/src/stages/access.ts#L712). По [документации OpenSSH](https://man.openbsd.org/sshd_config#Include), Include поддерживает несколько путей, glob и условное включение внутри Match; относительные пути разрешаются относительно `/etc/ssh`.

Контрпример N03:

```text
/etc/ssh/sshd_config:
  Include /etc/ssh/extra/access.conf

/etc/ssh/extra/access.conf:
  Match User factory
    PasswordAuthentication no  →  yes
```

До и после изменения оба хеша **идентичны**, включённый файл ни разу не прочитан, отказа нет. Проверка использует настоящий `observeAccessInputProof()` с in-memory filesystem, без системных SSH-файлов.

Общий `sshd -T` в `NodeAccessAdapter.observe()` не заменяет отслеживание всех входных файлов: в частности, conditional Match может не отражаться в dump без соответствующего connection context. Поэтому закрывать R13-F01/U01 как полную защиту reviewed inputs пока рано. Не утверждаю, что каждый нестандартный include всегда обходит effective-config hash: доказан конкретно пропуск raw-input inventory; динамический эффект зависит от конфигурации.

**Исправление:** либо построить ограниченный, детерминированный inventory всех фактически подключаемых конфигурационных файлов, либо явно отклонять неподдерживаемые Include до intent/effects. Нельзя молча считать фиксированный каталог полным inventory. Учитывать nested Include, Match, glob, case-insensitive keyword, quoted paths, циклы/лимиты, исчезнувшие файлы, directory membership, ownership и symlinks. Минимальное безопасное исправление может поддерживать только документированный стандартный layout и блокировать остальное с понятным сообщением. Оно не должно ломать стандартный Ubuntu include-layout.

Evidence: N03. Root-owned файлы нельзя делать общедоступными или перезаписывать ради того, чтобы collector заработал; безопасное чтение привилегированных входов относится к Q2.

## 4. Обновление статусов предыдущего аудита

| Старый ID | Решение после R1.4 | Основание |
|---|---|---|
| R13-F01: S03 input drift | **PARTIAL** | Исходный C11 закрыт до intent; неполный include inventory — R14-F03 |
| R13-F02: recovery engine-generated state | **CLOSED, local scope** | C01 direct/plan-first, child/recovery controls, checkpoint/progress сохранены |
| R13-F03: пропущенные S05 probes | **CLOSED для исходного дефекта** | C06 теперь вызывает probe и блокирует failed result; новый дефект целостности отдельно R14-F01 |
| R13-F04: неодинаковое evidence admission | **CLOSED, local scope** | C04/C09/C12 и 56 U05 cases; отказ не меняет evidence |
| R13-F05: Docker first-install cycle | **PARTIAL** | Старый prerequisite cycle устранён; реалистичный socket/session path — R14-F02 |
| R13-F06: mapping/недостающие проверки | **Исправлен в заявленной локальной матрице; coverage PARTIAL** | Mapping, manifest faults и S02 child controls теперь реальны; U06 всё ещё недостаточен для свежего host |

Названия старых C-сценариев в JSON намеренно оставлены историческими, например `…probes_skipped`. Они не являются текущим вердиктом: смотреть фактические поля. `harness_ok=true` означает выполнение сценария, а не безопасность продукта. Исходный R13 runner имеет старый oracle C04; R1.4 comparison runner корректно ожидает блокировку 8. Это учтено, а не выдано за новую ошибку.

## 5. Что остаётся до production

Состав работ нельзя свести к трём новым замечаниям. AF-05/06 и Q1A целиком по-прежнему не закрыты. Неразрешённые части общей AF-матрицы сохраняются до отдельной проверки.

| Очередь | Работа | Критерий перехода |
|---|---|---|
| **R1.5 сейчас** | R14-F01/F02/F03, реалистичные fixtures, точная матрица отчёта | Все новые отрицательные и положительные проверки; прежние recovery/receipt/crash guards сохранены |
| R2 | Свежесть и полнота plan/admission, binding config/host/операций/gates, отказ от подменённого/устаревшего плана | Перед эффектом выполняется именно текущий согласованный план; чужие/неполные планы отклоняются |
| R3 и Q1B | Cancel/expiry/ошибки/редактирование чувствительных данных в выводе; supervision дочерних процессов | Нет оставленных потомков, ложного cleanup-success и автоматического повторения неизвестного исхода |
| Q2 | Узкая sudo-модель, root-owned safe writes, APT provenance, настоящий SSH/UFW rollback/timer, Docker ownership/enforcement | Реальные implementations + negative adapter tests; затем отдельная квалификация на disposable Ubuntu |
| Q3 | Reviewed M0 release, installer↔application contract, offline runtime/image checks | Полный минимальный supervised/cloud-only/read-only toy путь без credentials |
| Q4 | Secrets/auth, ограниченный live smoke, reservation/reconciliation платных исходов, backup/restore | Изоляция секретов и проверяемые транзакции; live действия отдельно санкционированы владельцем |
| Q5 | Service/unattended, update, local inference, platform runners | Отдельные optional пакеты, не обязательные условия первого supervised deployment |
| Q6 | Release/CI/evidence и disposable VM qualification | Fresh install, repeat, reboot/relogin, disk/network/dpkg faults, gate denial/expiry, cancel, rollback/restore на exact release |

Особенно по sudo: текущий `NodeDockerAdapter.mergeOwnedDaemonLogConfig()` всё ещё использует предсказуемое имя `/tmp/agent-factory-s04-daemon-${Date.now()}.json` перед privileged install; полноценный безопасный privileged executor не реализован. Это прежний Q2/AF-08 blocker, не новая находка R1.4. `NodeAccessAdapter` всё ещё не выполняет реальный cutover/rollback. Переменные `FACTORY_SETUP_ALLOW_S03_MUTATIONS`/`S04_MUTATIONS` не являются достаточным доказательством безопасности.

В Q2 нужны фиксированные executable/argv, строгие paths/ownership/symlinks, минимальные разрешённые root-операции, атомарная установка конфигурации и настоящий rollback с проверяемой работой timer. Недопустимы root для всего installer, `NOPASSWD: ALL`, произвольные shell-команды, `chmod 666` для Docker socket и незаметное добавление `sudo` к application probes.

**NOT RUN в этом аудите:** disposable VM, реальные sudo/apt/systemd/SSH/UFW, Docker daemon/cgroups, OAuth, GitHub writes, платные provider/model calls, power-loss tests. Новые выводы основаны на чтении кода и безопасных воспроизводителях. Общая production-готовность не подтверждена.

## 6. Следующие действия владельца

1. Передать Copilot файл `copilot-r15-task.ru.md`, этот аудит и архив evidence. Рабочая копия должна содержать проверенный master; если SHA другой, агент сначала отражает разницу в отчёте, сохраняя чужие изменения.
2. Попросить выполнить **только R1.5 локально**. Запрет на commits/push/branches/PR уже включён в ТЗ и должен сохраняться в следующих промптах.
3. Получить от агента отчёт, полный локальный patch с новыми файлами, manifest SHA-256 проверенного дерева и архив тестовых доказательств. При следующей проверке приложить эти материалы: без push одного master будет недостаточно, чтобы увидеть локальные исправления.
4. Сейчас сервер, credentials и ручные sudo-настройки не нужны. Решение о публикации изменений и более позднем VM-прогоне остаётся за владельцем; оно не является частью R1.5.

Для следующего review важны `base_commit + patch + hashes`, а не новый коммит от агента. Пользователь при желании может самостоятельно опубликовать проверенные изменения позже; агент этого не делает.

## 7. Надёжность выводов и самопроверка

Подтверждённые факты: identity, checksums, 254 tests, исходные C-сценарии и новые N01/N02/N02a/N03. Уверенность в вердикте **R1.4 PARTIAL: 98%**. Вероятность воспроизведения конкретного поведения на всех реальных VPS не оценивалась: среды не запускались.

Самопроверка: не приравнивал passing mocks к VM qualification; отдельно проверил модель Docker через production adapter; заморозил fixtures новых контрпримеров; не переносил synthetic recovery case на engine-generated proof; отделил новый дефект от старого исправленного; не объявлял известный stub новым регрессом. Первоначальный прогон собственного harness содержал ошибку formatter (`envelope.errors` вместо `envelope.error`), исправлен до оценки результатов; ошибочный лог сохранён и не использован как evidence дефекта продукта.

Ограничение: проверка изменения и выбранных опасных путей не доказывает отсутствие иных ошибок. Обоснованное следующее действие — точечный R1.5 с сохранением текущего набора core-защит, затем последовательное закрытие roadmap.
