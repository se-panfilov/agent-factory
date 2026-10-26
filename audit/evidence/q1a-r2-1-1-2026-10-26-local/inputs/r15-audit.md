# Agent Factory — независимая проверка Q1A-R1.5

Дата: 2026-10-25, Europe/Amsterdam. Проверенный master: `b888082167b5edc50977a6dcda997b40e962da8d`, tree `9ed7b7e09eed8e80e099dc38578a9265ef634963`.

**Вердикт: R1.5 PARTIAL. Три исходных контрпримера R1.4 исправлены; обнаружен один остающийся дефект высокой серьёзности в привязке S05 command → проверенный файл. Production: OPEN.** Следующая работа — узкий пакет R1.6, описанный в `copilot-r16-task.ru.md`. Это проверка изменения и связанных опасных путей, а не заявление о повторной полной квалификации всей фабрики.

## 1. Что именно проверено

Получены и прочитаны отчёт `remediation-q1a-r1-5-2026-10-25.md`, `evidence.zip` и checksum. Полный patch взят из указанной пользователем папки `audit/evidence/q1a-r1-5-2026-10-25-local/`. В конце проверки удалённый master всё ещё указывал на `b888082`.

| Проверка identity | Результат |
|---|---|
| Base локального пакета | `d7d141106aa50f58c8ec9ac7c3991b4d9b42e6e6` |
| Отличие base от ранее проверенного `2eb026527d3448fc0d455f6fe8713cba61c0d3c5` | Только четыре входных audit-артефакта; production setup идентичен |
| Полный patch | SHA-256 `4d79264ffe10e7c58855d62a14f0feda2d95687593aeb9438cd7ec3a47608cb4` |
| Tested manifest | 135 файлов; SHA-256 `2d70f17d321a92acdabe9baa832e30adeab63b3ec9b6fc93b4481d06e8941f01` |
| Master ↔ manifest | Все 135 файлов совпадают |
| `git archive base` + полный patch ↔ manifest | Все 135 файлов совпадают; patch применяется без index |
| Входной ZIP | SHA-256 `5b75e2128b3a516d28e6ef35ee6f1bb7fe78f654d5a5fc666e473c22e28702a8`; CRC и все 91 записи внутреннего SHA256SUMS корректны |
| Вложения ↔ опубликованный пакет | Отчёт, ZIP и checksum совпадают по bytes |

Отчёт описывает локальное дерево до публикации, поэтому его последняя фраза «изменений на GitHub нет» уже историческая. Сейчас изменения действительно находятся в master. Сам факт публикации не доказывает нарушения агентом запрета на commit/push: пользователь мог опубликовать результат самостоятельно. Авторство этих действий по предоставленным данным отдельно не устанавливалось.

Прочитан diff всех пяти изменённых production-файлов: `adapters/git.ts`, `adapters/docker.ts`, `stages/application.ts`, `stages/docker.ts`, `stages/access.ts`, соответствующие tests/helpers/docs и evidence. Core engine/state, публичные schemas/contract и M0 этим пакетом не менялись. Репозиторий продукта в ходе аудита не исправлялся; создана отдельная копия для сборки и проверки.

## 2. Независимая валидация

Среда аудитора: Linux x86_64, Node **v24.22.1**, npm **11.9.0**. Это отличается от заявленной среды автора — macOS arm64, Node v24.12.0. Обе среды относятся к локальной проверке, а не к qualification целевого Ubuntu VPS. Проверки адаптеров выполнялись в изолированной среде с UID 0; CLI развёртывания от root не запускался. Это ограничение явно сохранено в evidence и не выдаётся за owner-session deployment.

| Действие | Независимый результат |
|---|---|
| `npm --prefix setup ci --ignore-scripts --no-audit --no-fund` | Exit 0 |
| `npm --prefix setup run typecheck --silent` | Exit 0 |
| `npm --prefix setup run test --silent` | **364 passed, 0 failed, 0 skipped** |
| Frozen comparison runners на старом и новом production | Все команды завершены; отдельно проверены **33 продуктовых assertions: PASS** |
| Исходный N01/N02/N02a/N03 runner и адаптация только parent-directory fixture | На fixed по 6/6 безопасных ожидаемых результатов |
| C01…C12, lifecycle controls, stage compatibility, S06 no-op | Проверены; ожидаемые безопасные результаты сохранены |
| Полная композиция настоящих S00…S07 stage modules с fake external adapters | apply/status/resume = 0; APT install=1, Docker install/probe=1, cutover=1, build=1, application probes=7 |
| Новые W01…W04: настоящий application adapter + ProcessAdapter + Node child | W01 PASS; **W02/W03/W04 FAIL по продуктовым assertions** |
| Те же W01…W04 через настоящий S05 observe с согласованным receipt | W01 PASS; **W02/W03/W04 ошибочно возвращают `verified`** |

Из собственного полного тестового лога извлечены 36 R14 manifest-fault rows, 10 R14 child-crash rows, 4 recovery-write-fault rows, 10 R15 Docker-fault rows и 3 R15 Docker child-crash rows. Последние — реальные локальные дочерние процессы с IPC/SIGKILL, но Docker effects в них моделируются. Это не испытание реального daemon, перезагрузки VPS или потери питания.

Существенная оговорка к общей композиции S00…S07: она использует synthetic M0 checkout и уже активную Docker group. Реалистичная смена Docker session дополнительно проверяется отдельными V05/V06/V07 тестами. Нельзя называть эту композицию доказанным fresh install на реальном сервере.

## 3. Какие исправления принимаются

| Замечание / требование | Решение | Проверенное поведение |
|---|---|---|
| R14-F01: executable probe после уже обнаруженного content mismatch | **Исходный дефект CLOSED, local scope** | N01 plan/verify/status-refresh: exit 9, дополнительных probes 0. V01/V02 проверяют content/metadata faults и drift после materialization |
| R14-F02: restart до активной Docker session | **CLOSED, local scope** | Install → group → durable manual pause; restart/probe до login отсутствуют. Повтор старой session не создаёт новый intent; после нового login нужны свежие remaining plan/gate approvals |
| R14-F03: пропущенный внешний SSH Include | **CLOSED в согласованной policy B** | Неподдержанная Include-грамматика отклоняется. Допущенный стандартный directory inventory, content и ownership участвуют в proof |
| R1.5 V01/V02 | PASS для заявленных локальных integrity cases | Не заменяет проверку идентичности запускаемого entry, см. R15-F01 |
| R1.5 V03 | **PARTIAL** | Положительные/отрицательные существующие тесты проходят, но общий claim «Node eval/unbound entry не авторизуются» опровергнут W02…W04 |
| R1.5 V04…V07 | PASS в локальной матрице | Ошибки/неполные info/version/ps не превращаются в безопасный пустой daemon; account membership отделено от process membership; unknown effects не повторяются |
| R1.5 V08…V10 | PASS в policy B | Один global canonical Include до Match либо отсутствие Include; nested/external/conditional/другие patterns запрещены; это сознательно ограниченная поддержка |
| R1.5 V11/V12 | PASS как regression/packaging evidence | Тесты и identity подтверждены; утверждение обо всей безопасности R1.5 из этого не следует |

Policy B разрешалась предыдущим ТЗ. Не считаю отсутствие универсального SSH resolver новой ошибкой. Адаптация N03 добавляет только безопасные metadata `/etc` и `/etc/ssh`, чтобы добраться до Include-specific отказа. Адаптация C07 заново одобряет оставшиеся операции после login; gate binding не обходится. Обе адаптации обоснованны и применены одинаково к baseline/fixed.

## 4. R15-F01 — проверенный content entry расходится с фактически исполняемым Node entry

**P1 / высокая серьёзность. Уверенность в воспроизведённом поведении: 99%. Статус: OPEN.** Это один дефект привязки команды с двумя механизмами обхода и тремя отрицательными сценариями. Не выделяю каждый suffix или флаг в отдельное замечание.

Код в проверенном commit:

- `setup/src/adapters/git.ts`, `resolveCommandArgs`, строки 173–182: делает абсолютным только первый аргумент с `.js`, `.mjs` или `.ts`. `.cjs` и entry без расширения остаются относительными.
- Там же, `canonicalContentPath` / `assertOfflineCommands`, строки 185–205: для Node считает entry равным `argv[1]` и проверяет его наличие в `content_hashes`; строка с ведущим `-` не отвергается. Файл с именем `--eval` позволяет этой опции пройти validator.
- Там же, `probeCommands`, строки 511–536: после content hash checks вызывает старый resolver и добавляет `--help`.
- `setup/src/adapters/process.ts`, `CommandOptions` / `runCommand`, строки 23–31 и 75–83: поля `cwd` нет, `spawn` наследует текущий каталог.
- `setup/src/stages/application.ts`, `checkDeployment` / `checkedProbes` / `observe`, строки 337–385: prechecks проходят, результат probe становится основанием `verified`; дополнительной проверки фактического entry здесь нет.

### Механизм A: запуск одноимённого файла вне deployment

В проверенном deployment есть `runner.cjs` с корректным хешем. Manifest задаёт `['node', 'runner.cjs']`. У процесса setup иной текущий каталог, где существует другой `runner.cjs`. Production adapter хеширует первый файл, но запускает pinned Node с `['runner.cjs', '--help']`. Node разрешает относительный entry относительно текущего каталога и исполняет второй файл.

Тот же результат получен для `['node', 'runner']`. Изменять доверенный deployment после hash check не требуется: нет гонки и нет TOCTOU. Нужны отличающийся CWD и одноимённый файл в нём. Если такого файла нет, получается ошибка запуска корректного release — это также нарушение воспроизводимости.

### Механизм B: имя файла интерпретируется как опция Node

Manifest содержит настоящий hashed файл `--eval` и команду:

```json
["node", "--eval", "process.stdout.write(\"UNBOUND_OPTION_EVAL\\n\")", "--"]
```

Схема manifest и `assertOfflineCommands` принимают её. После добавления `--help` Node выполняет выражение из argv, а hashed файл `--eval` вообще не является программой. Разделитель `--` делает дописанный `--help` аргументом, не отменяющим eval.

Это опровергает заявленный запрет Node eval. Само выражение находится в manifest: **не утверждается, что данный случай позволяет незаметно изменить уже согласованный manifest**. Проблема — validator ошибочно принимает опцию за проверяемый executable entry, а политика отчёта обещает другое. Для механизма A исполняемые bytes действительно находятся вне проверенного content map.

### Доказательства

| Сценарий | Hashed file | Фактический stdout | Результат adapter / S05 observe |
|---|---|---|---|
| W01, positive `.js` | `<deployment>/runner.js` | `REVIEWED_ENTRY` | Обе help-пробы true; `verified` — корректно |
| W02, `.cjs` | `<deployment>/runner.cjs` | `UNREVIEWED_CWD_ENTRY` | Обе пробы true; **ложный `verified`** |
| W03, extensionless | `<deployment>/runner` | `UNREVIEWED_CWD_ENTRY` | Обе пробы true; **ложный `verified`** |
| W04, option-shaped entry | `<deployment>/--eval` | `UNBOUND_OPTION_EVAL` | Обе пробы true; **ложный `verified`** |

`evidence/command-identity-probes.cjs` использует настоящие `validateContractSchema`, `NodeApplicationReleaseAdapter`, `NodeFilesystemAdapter`, `NodeProcessAdapter`. Хеширование `/usr/bin/sha256sum` перехвачено и вычисляет SHA-256 реальных fixture bytes. Pinned Node path указывает на текущий Node 24 через созданный тестом symlink; это fixture, не проверка установки Node. Дочерние программы написаны аудитором и только печатают маркер. Секреты, сеть, продуктовые программы и привилегированные host operations не используются.

В режиме `stage` настоящему S05 подаются synthetic archive/checkout observations и receipt с точными archive/commit/path/manifest digest. Проверка hashes и запуск остаются настоящими. Поэтому доказан ошибочный stage observation, **не** полный exploit через подписанный архив/CLI/journal. Оба режима дали три отрицательных результата и один положительный; `harness_ok=true` и process exit 0 не считаются product PASS.

Риск: выполнение непредусмотренного кода с правами процесса setup и ложная верификация приложения. При обычной модели это права owner; если owner уже состоит в Docker group, blast radius потенциально существенно выше. **Root escalation или захват удалённого VPS этим аудитом не демонстрировались.**

Первичная справка: [Node.js CLI — Program entry point, `--`, `--eval`](https://nodejs.org/api/cli.html). Документация описывает разрешение относительного entry через CWD и выполнение eval-аргумента. Основное доказательство здесь — фактическое выполнение на Node v24.22.1, а не перенос утверждения с текущей версии документации.

### Требуемое исправление

Нужна одна согласованная подготовка команды для validation и execution: определить её вид, проверить canonical content key, получить абсолютный executable/Node entry именно в deployment и передать именно его процессу. Node options не должны становиться file entry из-за совпадения с ключом `content_hashes`. Обработка не должна зависеть от списка расширений.

Не закрывают дефект: добавление только `.cjs`, blacklist только `--eval`, добавление `cwd` в mock при отсутствии его поддержки настоящим ProcessAdapter, ослабление probes до unconditional success, запуск через shell/sudo. Полный процессный supervisor и устранение всех OS races остаются отдельным Q1B/Q2 scope; для этой ошибки не нужны ни root helper, ни расширение привилегий.

## 5. Порядок дальнейшей работы

| Очередь | Содержание | Условие перехода |
|---|---|---|
| **R1.6 сейчас** | Исправить R15-F01; negative/positive tests с actual argv/CWD; честно обновить V03/report | W02/W03 исполняют только проверенный entry, W04 отвергнут до child; старые 364 теста и comparison controls сохранены |
| R2 | Полнота/свежесть plan/admission, binding config/host/operations/gates | Устаревший, подменённый, чужой или неполный plan отклоняется до effect |
| R3 / Q1B | Cancel, gate expiry, ошибки/редактирование секретов в выводе, supervision потомков | Нет оставшихся процессов, ложного cleanup-success и replay неизвестного исхода |
| Q2 | Узкая sudo-модель, безопасные root-owned writes, APT provenance, настоящий SSH/UFW rollback/timer, Docker enforcement | Реальные реализации, отрицательные adapter tests, затем отдельно санкционированный disposable-host прогон |
| Q3 | Reviewed M0 release и installer/application contract | Полный минимальный supervised/cloud-only/read-only toy путь без credentials |
| Q4 | Secrets/auth, ограниченный live smoke, платные uncertain outcomes, backup/restore | Изоляция секретов, reconciliation и проверяемое восстановление |
| Q5, optional | Service/unattended, updates, local inference, дополнительные платформы | Отдельные доказательства; не обязательное условие первого supervised deployment |
| Q6 | Exact release + CI/evidence + disposable Ubuntu 24.04 amd64 | Fresh/repeat/reboot/relogin, отказ gates, cancel, disk/network/dpkg faults, rollback/restore |

AF-05/06 и Q1A целиком не закрываются этим локальным пакетом. Прочие незакрытые AF сохраняют прежний статус до отдельного evidence review; обновление R1.5 не даёт оснований массово переводить AF в PASS.

Особенно по sudo: S03 `NodeAccessAdapter.applyCutover` остаётся пустым, recovery/timer используют manual markers — это **code blocker**, а не только отсутствующий VM-тест. `NodeDockerAdapter.mergeOwnedDaemonLogConfig` по-прежнему создаёт предсказуемый `/tmp/agent-factory-s04-daemon-${Date.now()}.json` перед privileged install. Эти известные Q2 границы не исправлены R1.5. Нового расширения sudo-прав в diff не обнаружено; существующая модель ещё не квалифицирована. `FACTORY_SETUP_ALLOW_S03_MUTATIONS=1` / `S04_MUTATIONS=1` не заменяют доказательство безопасности.

## 6. Действия владельца

1. Передать Copilot **`copilot-r16-task.ru.md`**, этот аудит и evidence ZIP. Выполнить только R1.6.
2. Все изменения оставить локально: **без commits, push, новых веток и PR**. Запрет уже включён в промпт; публикация владельцем отдельно не требуется для следующего review.
3. Получить отчёт, полный patch с новыми файлами, tested-tree SHA manifest и evidence ZIP/checksum. Для следующей проверки приложить их либо дать локальную папку с этими файлами. Ссылки на неизменённый master недостаточно для локальных правок.
4. Сейчас дополнительные VPS, credentials и ручные sudo-настройки не нужны. Реальное развёртывание следует отложить до закрытия code blockers и отдельной квалификации.

## 7. Ограничения и самопроверка

**NOT RUN:** disposable VM/VPS, реальные sudo/apt/systemd/SSH/UFW, Docker daemon/cgroups, OAuth, GitHub writes, provider/model calls, release/deploy и physical power loss. Запущены локальные тестовые дочерние Node-процессы, включая stdout-only fixtures и repository crash-test helpers; это отдельно от запрещённых host effects.

Факты: identity/checksums, 364 теста, 33 assertions и W01…W04 воспроизведены. Вывод о R1.5 **PARTIAL**: уверенность **99%**. Возможность эксплуатации на конкретном VPS не оценена. Production readiness не подтверждена и известные code blockers остаются.

Самопроверка: сохранены заслуги исправлений R1.5; отказ от неподдержанных SSH layouts не назван дефектом; старые ошибки не выданы за новые; hash/exec mismatch отделён от race и от полномочий root; real child execution отделено от simulated archive/receipt и от полноценного deployment. Ошибки вспомогательных чтений/недоступность versioned web docs не учитывались как ошибки продукта. Не утверждается отсутствие других дефектов за пределами проверенных путей.
