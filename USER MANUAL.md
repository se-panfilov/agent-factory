# AI Software Factory — точный маршрут Copilot → проверки → VPS

**Основание:** документы из `agent-factory-repo-starter.zip` / `docs/automation/`, руководство редакции 4.1, план P00–P15, CONTRACT 1.0.0. Подготовлено как пользовательская последовательность, а **не** утверждение, что скрипты уже существуют или были испытаны.

## Ключ к обозначениям

- **P00–P15** — шестнадцать последовательных PR по **установщику** (`setup/`). Полные технические задания уже лежат в `docs/automation/copilot-prompts/`.
- **M0.1–M0.3** — мои три удобные рабочие подзадачи для реализации обязательного **M0 application release** из исходного guide (application PR0/1, плюс packaging). Это **дополнительные промпты**, не отдельные официальные номера PR из архива.
- **S00–S14** — этапы, которые **будущий установщик** выполняет на сервере. Не путать P09 (написать GitHub stage) и S09 (применить его на VPS).
- **M1/M2** — будущие application milestones для постоянного сервиса/unattended. P10 может быть реализован и проверен на fake backend до M1/M2, но нельзя включать реальную службу, которой нет.
- **`factory-setup`** и `bootstrap.sh` в документах — **planned CLI**. Пока нет принятого P15 release, НЕ запускать эти команды в расчёте на работу.

### Рекомендованный реальный порядок

**Подготовка репозитория → P00 → P01 → P02 → M0.1 → M0.2 → M0.3 → P03 → P04 → P05 → пробная disposable VM → P06 → P07 → P08 → пробный offline runner → P09 → P10 → P11 → P12 → P13 → P14 → P15 → VM qualification → постоянный VPS и S00–S09/S11.**

P10/P12/P13 разрабатываются, но **реальная служба, локальная Qwen и Windows/macOS CI необязательны для первого supervised запуска**. При недостатке времени полезная промежуточная цель — P08 + M0, а не ожидание всей гибридной фабрики.

## Перед первым промптом: подготовка один раз

1. Распакуй `agent-factory-repo-starter.zip`. Проверь, что в корне есть `AGENTS.md`, а в `docs/automation/` — `CONTRACT.md`, `agent-factory-guide.ru.md`, `copilot-prompts/`.
2. На GitHub в правом верхнем углу `+` → **New repository** → имя `agent-factory` → **Private** → Create. Если он уже существует, используй его и не затирай существующий `AGENTS.md` / `.github/`.
3. Загрузи starter в приватный репозиторий через Git/VS Code и сделай начальный commit. `auth/`, `state/`, `.env`, секреты и credential-файлы никогда не коммить. Разумно проверить `git status` и `git diff --cached --name-only` перед push.
4. Открой корень в VS Code и Copilot **Agent mode**. Выполняй **только один** Pxx/M0 за раз. Для каждого начинай отдельную ветку; после изменений открой PR на GitHub, прочитай diff и тесты, сделай merge в `main`; лишь потом следующий prompt.
5. Если Copilot не умеет создать PR сам, сделай через VS Code Source Control: commit → Publish Branch → на GitHub вкладка **Pull requests** → **New pull request**, base=`main`, compare=твоя ветка → Create pull request. Для просмотра: **Files changed**; после review — **Merge pull request** → Confirm merge. Не путай PR в `agent-factory` с PR в `anarchy-engine`.
6. После merge синхронизируй локальную ветку `main` через Git pull. Не давай новому заданию стартовать со старого состояния.

### Что значит «проверить PR» каждый раз

Минимальная проверка: (а) diff меняет ожидаемые файлы, (б) отсутствуют реальные ключи, случайный `.env`, `auth/`, `state/`, (в) тесты действительно запускались, а не описаны как planned, (г) `setup/docs/implementation/Pxx.md` или `docs/application/M0-*.md` честно перечисляет `NOT RUN`, (д) нет повышения привилегий/опасных silent fallback. Copilot review полезен, но не заменяет твоего review. Если что-то не готово — исправление в **том же PR**, не новый Pxx.

---

## Промпты installer: P00–P02

### P00 — Основание установщика

Полное ТЗ в `docs/automation/copilot-prompts/00-contract-and-foundation.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только installer P00** по `docs/automation/copilot-prompts/00-contract-and-foundation.md`.
Прочитай этот файл целиком, затем `AGENTS.md`, `docs/automation/CONTRACT.md` (1.0.0), `copilot-execution-plan.md` и актуальный guide 4.1. Создай фундамент `setup/`: строгие JSON Schema, TypeScript-контракты, валидаторы, fixtures и тесты, не подменяя отсутствующий код заглушками. Сохрани разделение installer/application. Не выполняй установку, sudo, Docker, модельные запросы и GitHub mutations на текущем компьютере. Работай в отдельной ветке `setup/p00-foundation`, только в разрешённом scope. Запусти безопасные тесты и typecheck, запиши реальные результаты в `setup/docs/implementation/P00.md`; перечень неисполненного отметь `NOT RUN`. Остановись после реализации P00: не начинай P01, ничего не merge и не публикуй.
```

**Твои действия после Copilot:** Проверяешь созданный `setup/`, валидаторы, отсутствие изменений в `auth/`/`state/` и успешные реальные тесты. В GitHub просматриваешь PR и лишь затем merge в `main`.

### P01 — Bootstrap без Node.js

Полное ТЗ в `docs/automation/copilot-prompts/01-bootstrap.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только P01** по `docs/automation/copilot-prompts/01-bootstrap.md`. Сначала проверь, что P00 уже принят в `main`, прочитай `AGENTS.md`, контракт 1.0.0 и P01 полностью. Создай строго ограниченный `setup/bootstrap.sh`: установка проверенного pinned Node в пользовательское окружение из заранее доверенного release, без произвольного `curl | sudo bash`, без перезаписи чужих файлов и без root-запуска основного CLI. Предусмотри idempotency, checksum/signature failures, offline/error cases, минимальные sudo gates. Все тесты — через mocks/fixtures; реальный apt на моей машине не запускай. Создай `setup/docs/implementation/P01.md` с результатами и `NOT RUN`; ветка `setup/p01-bootstrap`. Не переходи к P02, не запускай bootstrap на настоящем VPS.
```

**Твои действия после Copilot:** Читаешь `bootstrap.sh`, особенно всё, что связано с `sudo`, скачиванием бинарников, правами и источниками файлов. Проверяешь негативные тесты, затем merge.

### P02 — CLI, состояния и возобновление

Полное ТЗ в `docs/automation/copilot-prompts/02-core-cli-state.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только P02** по `docs/automation/copilot-prompts/02-core-cli-state.md`. Прочитай весь prompt, `AGENTS.md`, `CONTRACT.md`, execution plan; убедись, что P00–P01 merged. Построй детерминированные `factory-setup` CLI и engine: config/plan/observed state/checkpoints, manual gates, locking, resume, typed errors и injectable adapters. Должны работать сценарии partial failure, duplicate invocation, stale plan, config drift, crash before/after effect, lock recovery; старый checkpoint не означает verified. Тесты не должны запускать реальный sudo, apt, Docker, AI или GitHub writes. Соблюдай договорённые exit codes и CLI flags без придумывания новых. Выполни тесты, оформи `setup/docs/implementation/P02.md` с фактическим evidence, в отдельной ветке `setup/p02-core`. Не начинай P03 и не применяй installer на host.
```

**Твои действия после Copilot:** Проверяешь план/состояния/lock/gates, тест на crash→resume, отсутствие побочных действий. Это ключевой PR: если проверка состояния сомнительна, дальше не идём.

## M0: обязательная разработка самого приложения (после P02, до P06)

**Ниже три новых промпта M0.1–M0.3.** Их можно делать после P02. Они не подменяют Pxx; это отдельные application PR.

### M0.1 — Основа приложения — application PR 0

**Скопируй в Copilot:**

```text
Это **application milestone M0.1**, не installer Pxx. Прочитай `docs/automation/agent-factory-guide.ru.md`, раздел «PR 0 — основание без внешних действий», приложения A1–A3, `docs/automation/CONTRACT.md`, секцию application manifest, и `AGENTS.md`. В отдельной ветке `app/m0-01-foundation` реализуй только основу приложения AI Software Factory: TypeScript domain, схемы четырёх ролей, безопасные fixtures fake provider и тесты с инвариантами SHA/structured result. Не трогай `setup/` и уже принятые installer contracts; не включай облачные вызовы/GitHub writes/Docker. Настоящие typecheck и unit tests должны пройти; подготовь отчёт `docs/application/M0-01.md` с честным NOT RUN. Попроси review, не начинай runner и не делай merge без меня.
```

**Твои действия:** Убедись, что существует **приложение**, отличное от `setup/`; PR не ломает P00–P02. Запусти тесты и прими PR.

### M0.2 — Supervised read-only runner — application PR 1

**Скопируй в Copilot:**

```text
Это **application milestone M0.2**, не installer Pxx. Прочитай `docs/automation/agent-factory-guide.ru.md`, «PR 1 — контролируемый Local Agent Runner» и приложения A1 `make-schemas.ts`, A2 `runner.ts`, A3 `verify.mjs` плюс замечания об ограничениях A2, особенно F15; также `AGENTS.md` и `docs/automation/CONTRACT.md`. После принятого M0.1 реализуй действительный supervised read-only Scout Runner: Codex CLI в Docker worker, run ID, input SHA, JSON Schema/Ajv, stop/status/inspect, timeout, bounded logs/results, termination+verified container cleanup, one LLM, no retries, unknown usage fail closed. Дополнительная обработка F15: redaction raw logs, symlink-safe result reading after cleanup, residual container check. Модельные credentials изолированы, Worker не получает GitHub write token/socket/host home. Реальные Codex login и Docker test на моём хосте НЕ выполняй; безопасные fixtures и typecheck выполни. Работай в `app/m0-02-runner`, отчёт `docs/application/M0-02.md`. Не начинай приложение PR2 и не создавай installer logic.
```

**Твои действия:** Проверь негативные кейсы: wrong SHA, invalid JSON, timeout, stop, orphan container; любое неисполненное Docker test должно оставаться NOT RUN.

### M0.3 — Проверяемый application release с manifest

**Скопируй в Copilot:**

```text
Это **application milestone M0.3 packaging**, не installer Pxx. После принятых M0.1/M0.2 прочитай `docs/automation/CONTRACT.md` (application release/`deployment-manifest.json`, S05/S07) и `docs/automation/automation-plan.md`. Подготовь воспроизводимую поставку **реально существующего** supervised runner с A1/A2/A3, fixtures, scripts/config/schema и строгим `deployment-manifest.json`: source_commit, content_hashes, node_range, capabilities и проверенные argv команды `runner_run`, `runner_status`, `runner_stop`, `verify_fake`. Никаких вымышленных `serve/recover/migrate` и claims `unattended`/`hybrid`. Не вписывай вымышленные SHA, hashes или «прошедшие» тесты. Запусти безопасную offline verification, подготовь документацию сборки/проверки и реальное архивирование только из доверенного Git commit. Работа в `app/m0-03-release`, отчёт `docs/application/M0-03.md`. Не меняй `setup/` кроме заранее согласованных интерфейсных файлов; не деплой на VPS и не логинься в модели.
```

**Твои действия:** Убедись, что manifest соответствует файлам и SHA; умеешь получить архив M0, но его live готовность станет подтверждённой только после настоящего Docker/OAuth smoke.

## Продолжаем installer P03–P15

### P03 — Системные пакеты Ubuntu

Полное ТЗ в `docs/automation/copilot-prompts/03-system-dependencies.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только P03** по `docs/automation/copilot-prompts/03-system-dependencies.md`, после принятого P02. Прочитай контракт и правила. Добавь stage S02 и apt adapter для Ubuntu 24.04 amd64: preflight, pinned packages, sudo gates, `dpkg`/apt lock, наблюдение уже установленного, bounded waits, контроль версий, refusal вместо опасного auto-repair. Unit/integration tests используют fake processes/filesystem, не настоящий apt. Никакой автоматической перезагрузки, скрытого full-upgrade или удаления чужих пакетов. Ветка `setup/p03-system`; отчёт `setup/docs/implementation/P03.md`, фактически запущенные tests и `NOT RUN`. Не переходи к P04.
```

**Твои действия после Copilot:** Смотришь список пакетов и действий под sudo. При конфликтующих версиях не разрешай Copilot «почистить систему» автоматически.

### P04 — SSH/Tailscale/firewall

Полное ТЗ в `docs/automation/copilot-prompts/04-secure-access.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только P04** по `docs/automation/copilot-prompts/04-secure-access.md` после P03. S03 обязан защищать от потери SSH: owner-confirmed provider console, независимый второй вход, Tailscale login gate, явный diff sshd/firewall, проверка IPv4/IPv6, staged change с rollback timer и безопасным отказом. Никаких сетевых изменений текущего компьютера или VPS без отдельного моего разрешения. Настоящий cutover проверяется ТОЛЬКО на disposable VM/VPS с console и ручным участием; в этом PR запусти только deterministic tests. Соблюдай `CONTRACT.md`, не выдумывай silent approval. Ветка `setup/p04-access`, отчёт P04 с перечислением `NOT RUN`. Не переходи к P05.
```

**Твои действия после Copilot:** Это рискованный PR. Прочитай `setup/docs/access-recovery.md`. До практической проверки обеспечь доступ через консоль провайдера и второй SSH-вход; не экспериментируй с основным рабочим сервером.

### P05 — Docker host

Полное ТЗ в `docs/automation/copilot-prompts/05-docker-host.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только P05** по `docs/automation/copilot-prompts/05-docker-host.md` после P04. Поддержи S04: официальные проверенные Docker packages, совместимость клиента/демона, daemon config diff без перезаписи чужого, ресурсы CPU/RAM/PID, отсутствие публичного Docker API, Docker group как root-equivalent manual gate, требование relogin. Если Docker уже есть или daemon обслуживает чужие контейнеры — inspect и blocked, не uninstall/restart без подтверждения. Напиши meaningful fake integration tests и отчёт P05; реальные Docker/sudo действия на хосте не выполняй. Ветка `setup/p05-docker`. После P05 остановись.
```

**Твои действия после Copilot:** Проверяешь Docker socket/group/daemon изменения и тесты; после merge подготовь **отдельную disposable Ubuntu VM** для испытаний S00–S04. Не подключай для этого основной VPS.

### P06 — Доставка готового приложения

Полное ТЗ в `docs/automation/copilot-prompts/06-application-release.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только P06** по `docs/automation/copilot-prompts/06-application-release.md` после P05. S05 должен разворачивать **уже существующий проверенный M0 application release**, а не создавать runner сам. Добавь безопасный Git/release adapter, проверку source commit, deployment-manifest, hashes, безопасную распаковку (no traversal/symlink), owner approval для Dockerfile/build, no destructive reset. Тестируй и на synthetic/fake artifacts; при отсутствии действительного M0 верни explicit blocker. Не вводи secrets и не запускай настоящий production build. Ветка `setup/p06-release`. Отчёт P06 с tests/NOT RUN; не начинай P07.
```

**Твои действия после Copilot:** Убедись, что код P06 не пытается сам писать фабрику. Проверь, что твой M0 release содержит manifest, конкретный SHA и проверяемые файлы.

### P07 — Конфигурация и образы

Полное ТЗ в `docs/automation/copilot-prompts/07-configuration-images.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только P07** по `docs/automation/copilot-prompts/07-configuration-images.md` после P06. Реализуй S06: конфигурации и схемы, user-private auth/state dirs, canonical toy fixture, pinned agent image, проверки версий/Codex CLI и неизменности build context. Никаких секретов в образе или Git, никакого переписывания изменённых пользователем конфигов без `.proposed` + diff/gate. image ID, созданный на другой машине, не считается действительным на VPS. Используй fake adapters для tests, не устанавливай ничего на host. Ветка `setup/p07-config-images`, отчёт P07 и настоящие тесты. Не начинай P08.
```

**Твои действия после Copilot:** Проверяешь, что `auth/` и `state/` не попадут в Git/образ, конфиги не перезаписываются, версии и digest не подменяются на `latest`.

### P08 — Offline проверки и явная авторизация

Полное ТЗ в `docs/automation/copilot-prompts/08-verification-auth.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только P08** по `docs/automation/copilot-prompts/08-verification-auth.md` после P07. Реализуй S07 offline verification через fake provider и no-secret Docker fixture; S08 — отдельные explicit команды авторизации и owner-approved одного live smoke. `init/apply/resume` не должны скрытно выполнять OAuth, AI call или paid fallback. Login status не равен доступной квоте. Ошибка cleanup/schema/unknown usage => blocked, не verified. Покрой отказные сценарии детерминированными tests без реальных credentials и без live AI. Ветка `setup/p08-verify-auth`; отчёт P08 с `NOT RUN` интеграцией. Остановись после PR.
```

**Твои действия после Copilot:** После merge и при наличии M0 можно проводить **предварительные тесты P00–P08 на одноразовой Ubuntu VM** с явно помеченным development build. Полноценный доверенный setup release, полный `versions.lock` и production qualification — задача P15; не называй предварительный bootstrap готовой установкой. Первый реальный Codex login/live smoke — только по отдельному твоему решению.

### P09 — Подключение anarchy-engine / GitHub

Полное ТЗ в `docs/automation/copilot-prompts/09-project-github.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только P09** по `docs/automation/copilot-prompts/09-project-github.md` после P08. S09 должен подготавливать локальный checkout по конкретному SHA и **предлагать** GitHub Project/baseline/Dependabot конфигурации, но не делать незапрошенные GitHub writes. Создай `setup/docs/github-manual.md` с пошаговыми UI-действиями для новичка: issue, Project Board/fields, PR для baseline workflow, запуск `workflow_dispatch`, проверка реального checkout SHA и сохранение evidence. Отсутствующий CI => unknown, а не pass. Use fake GitHub adapters, fixture tests, exact SHA binding. Ветка `setup/p09-project`, отчёт P09 с NOT RUN. Не начинай P10.
```

**Твои действия после Copilot:** Создай GitHub Project и первое Issue вручную; workflow сначала проверь как diff, затем merge PR в **anarchy-engine**, и только потом нажимай Actions → Run workflow. Подробная инструкция ниже.

### P10 — Постоянная служба и хранилище

Полное ТЗ в `docs/automation/copilot-prompts/10-service-storage.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только installer P10** по `docs/automation/copilot-prompts/10-service-storage.md` после P09. Предоставь S10: systemd/service deployment и вызов **существующего** app migrator. **Не реализуй приложение M1/M2 внутри installer**. Если в manifest нет настоящих `recover/serve/pause/stop/migrate` либо нет M2 security evidence, вернуть `blocked: capability_missing` с инструкцией. Должны быть explicit service-enable и DB migration gates, backup, paused start и rollback; без автоматического unpause. Тесты — fake systemd/app, без изменений host. Ветка `setup/p10-service`, отчёт P10. Не начинай P11.
```

**Твои действия после Copilot:** Для supervised MVP ничего включать не нужно: S10 заблокирован без M1/M2 — это ожидаемо. Не подтверждай установку службы как «готово», пока нет настоящего приложения.

### P11 — Backup, health, emergency

Полное ТЗ в `docs/automation/copilot-prompts/11-operations.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только P11** по `docs/automation/copilot-prompts/11-operations.md` после P10. Для S11 добавь status/health, backup create/verify, безопасное восстановление, emergency cancellation только принадлежащих системе ресурсов, runbook для SSH/VPS/reboot. Сохраняй PAUSED и unknown usage, не копируй auth в backup, не удаляй последнюю хорошую копию. При отсутствии app capability explicit blocker + ручная процедура, а не фиктивный success. Service features зависят от M1/M2, но Level1 supervised backup возможен отдельно. Всё тестируй fake adapters/temp dirs, без настоящего systemd/VPS. Ветка `setup/p11-ops`, отчёт P11. Не переходи к P12.
```

**Твои действия после Copilot:** Посмотри сценарий восстановления из backup и stop. Позже реально заберёшь резервную копию с VPS на свой компьютер и проверишь restore в отдельной среде.

### P12 — Необязательный Ollama/Qwen

Полное ТЗ в `docs/automation/copilot-prompts/12-optional-inference.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только P12** по `docs/automation/copilot-prompts/12-optional-inference.md` после P11. S12 — только **optional inference infrastructure**: safe/private Ollama service, проверка model artifact/digest/ресурсов, health и отключение. По умолчанию cloud-only; при отсутствии M3/прикладных PR13–17 не заявляй working hybrid routing. Не скачивай реальную модель, не запускай inference, не открывай порт наружу без моего явного разрешения. Обработай RAM/disk limits, OOM и idempotent disable. Fake tests и отчёт P12; ветка `setup/p12-inference`. Не начинай P13.
```

**Твои действия после Copilot:** На VPS модель пока не устанавливаем. Это optional функция; сначала измерим CPU/RAM, затем решим, стоит ли вообще включать её.

### P13 — Необязательные платформенные проверки

Полное ТЗ в `docs/automation/copilot-prompts/13-optional-platforms.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только P13** по `docs/automation/copilot-prompts/13-optional-platforms.md` после P12. S13 формирует предложения GitHub Actions для Linux/Windows/macOS и проверяет readiness; не утверждает, что реальные platform checks существуют без application PR12 browser_smoke/collector. Workflow — без чувствительных write permissions/секретов, никаких публикаций на GitHub из unit tests. Сохраняй pinning runner/platform/sha, missing check => unknown/blocked. Не запускай платные matrix workflows автоматически. Fake/fixture tests, отчёт P13, ветка `setup/p13-platforms`. Остановись до P14.
```

**Твои действия после Copilot:** Ручное добавление платформенного workflow и первый запуск — позднее и отдельно. Для MVP не нужно платить за macOS CI.

### P14 — Обновления и recovery

Полное ТЗ в `docs/automation/copilot-prompts/14-maintenance-update.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только P14** по `docs/automation/copilot-prompts/14-maintenance-update.md` после P13. S14 проектирует и выполняет только отдельно утверждённые staged updates проверенных installer/app releases. Нужны version/manifest compatibility, pre-update backup, immutable old release, paused migration, owner approval для diff, безопасный rollback/recovery с сохранением PAUSED. Запрет: `git pull` в production дерево, тихое обновление `latest`, destructive cleanup, запуск других AI-task. Напиши crash/rollback/drift fixtures, используй fake runners; не обновляй хост. Ветка `setup/p14-updates`, отчёт P14. Не начинай P15.
```

**Твои действия после Copilot:** Проверь, что installer может обновляться независимо от запущенной фабрики и не разрушает конфиги. Реальное обновление отложено до тестового сервера.

### P15 — Интеграционная приёмка и release

Полное ТЗ в `docs/automation/copilot-prompts/15-qualification-release.md`. Текст ниже — **короткая команда запуска**, Copilot обязан прочесть полное ТЗ.

**Скопируй в Copilot:**

```text
Реализуй **только P15** по `docs/automation/copilot-prompts/15-qualification-release.md` после P14. Интегрируй P00–P14, проверь точный CONTRACT1.0.0, package/lock, создавай reproducible signed/checksummed setup release и versions.lock **только из реально проверенных pinned artifacts**. Создай `setup/tests/vm/`, `setup/docs/qualification.md`, quickstart, release instructions и comprehensive failure matrix. Unit/integration tests выполни безопасно; подготовь отдельную VM qualification с явным owner consent, НЕ тестируй на моём рабочем хосте или production VPS без разрешения. Не называй mocks VM proof и не объявляй production-qualified без реальных fresh/second/reboot/recovery VM результатов и M0. Ветка `setup/p15-qualification`, отчёт P15. Остановись: release/merge только после моего review.
```

**Твои действия после Copilot:** Здесь ты предоставляешь одноразовую VM, просматриваешь реальные журналы установки/повтора/прерывания/восстановления, подписанный архив и manifest. После этого можно покупать постоянный VPS.


## Ручные действия между промптами, о которых легко забыть

### После P02: M0 — не установщик, а само приложение

Открой отдельные application PR, используя M0.1 → M0.2 → M0.3 выше, не смешивая их с PR установщика. Реализацию можно было бы делать параллельно в другом checkout, но при одном разработчике безопаснее последовательное включение в `main`. M0 не создаёт полноценный orchestrator — только supervised read-only runner. В M0.3 наличие manifest с перечислением функций **не доказывает** работоспособность отсутствующих функций.

### После P05: тестовый Ubuntu, пока НЕ постоянный VPS

Создай **одноразовую Ubuntu 24.04 amd64 VM** (на отдельном тестовом VPS или локальной виртуализации, если удобно), с консолью восстановления/снимком. Это машина для испытаний, которую можно пересоздать, без настоящих секретов и личных проектов. Проверь bootstrap, idempotency, SSH/Tailscale/firewall rollback, Docker и повтор после перезагрузки. Не выключай первоначальное SSH-подключение до успешного **второго** входа. Любые реальные host tests должны запускаться отдельно и явно, не через `npm test`.

### После P08 + M0: первая полезная проверка

На тестовой Ubuntu можно проверить реализованные к P08 действия S00–S07 **через разрешённую pre-release test-сборку**, если она действительно подготовлена и её зависимости доступны. Если окончательный `versions.lock` или trusted bootstrap/release отсутствует, выполните только реализованные fixture/integration/VM-пробы и запишите `blocked` для полного пути S00–S07; **P15 ещё не пройден**. Целевой результат рабочего offline-теста: `runner_ready_offline`, а не «вся фабрика готова». Только затем при желании S08: device login Codex через официальный сайт, один явно одобренный live toy Scout, проверка `needs_review`/чистого SHA/отсутствия контейнера. Не выбирай API paid fallback. Если проверка не выполнялась — в статусе должно остаться `NOT RUN` или `blocked`.

### После P09: создаём GitHub Project — коротко по кнопкам

**Project** — визуальная доска карточек. **Issue** — описание задачи; **PR** — предложение изменений кода; **Actions workflow** — файл YAML, который запускает проверки на GitHub. На раннем этапе статусы вручную двигаешь ты; проектная доска пока не является автоматическим оркестратором.

1. Открой **приватный `agent-factory`** на GitHub и вкладку **Issues** → **New issue**. Заголовок: `Audit anarchy-engine CI at a fixed SHA`. В описании: `Project: se-panfilov/anarchy-engine; Goal: read-only карта unit/typecheck/E2E; Input SHA: [впиши фактический git rev-parse HEAD]; Forbidden: source edits, push, release; Budget: one Scout run, 5 minutes, zero retry`. Создай issue.
2. Нажми на свой аватар → **Your profile** → вкладка **Projects** → **New project** → шаблон **Board** → назови `AI Factory Tasks` → импортируй карточку issue из приватного `agent-factory` (если предложено) или добавь позднее. Сохрани видимость **Private**, если соответствующая настройка отображается.
3. Отредактируй поле статуса (`Status`) так, чтобы в доске были этапы **Proposed → Ready → Running → Checks → Needs owner → Done** плюс **Blocked**. Интерфейс GitHub может меняться: это не команды терминала, а названия статусов, которые ты создаёшь/переименовываешь в настройках Project.
4. При необходимости добавь пользовательские поля `Repository`, `Risk`, `Run ID`, `PR`, `Candidate SHA`, `Decision needed`. Пока можно начать со статуса и ссылки на issue/PR; недостающие поля нужны прежде всего для последующей интеграции.
5. Перетащи карточку в **Proposed**, затем в **Ready**, когда утвердишь задачу. `Running` выставляй лишь с существующим run ID; `Done` — только после реального evidence и человеческого решения. Не ожидай уведомления только из-за перемещения карточки.

**Baseline workflow — подробнее по шагам:**

6. Теперь открой **отдельный репозиторий `se-panfilov/anarchy-engine`**. Baseline — проверка *уже существующего* кода на фиксированном commit до того, как агент станет его изменять. Сначала посмотри вкладку **Actions**: есть ли завершённый проход подходящей проверки на нужном SHA? Если есть, зафиксируй ссылку и результат; отдельный workflow может не понадобиться.
7. Если подходящего запуска нет или соответствующие изменения исключены из CI, используй YAML proposal, созданный P09, либо пример `.github/workflows/factory-baseline.yml` из раздела 5.3 руководства. Не переноси YAML вслепую: проверь с Copilot/сам, что он read-only (`permissions: contents: read`), checkout привязан к `candidate_sha`, используются реальные команды движка и там нет deploy/publish или write token.
8. Создай **отдельную ветку в `anarchy-engine`**, добавь `.github/workflows/factory-baseline.yml`, commit/push → GitHub **Pull requests → New pull request** → проверь **Files changed** → **Merge pull request**. Это PR **в движке**, а не очередной installer Pxx.
9. После merge workflow оказывается в default branch `main`. Открой `anarchy-engine` → **Actions** → слева **Factory baseline** → **Run workflow** → выбери `main` → введи полный 40-символьный commit SHA в `candidate_sha` → Run workflow. `Run workflow` будет только при наличии `workflow_dispatch` в YAML и workflow в default branch.
10. Дождись окончания, открой run и журнал **Validate SHA / Record actual checkout**. Убедись, что фактически checked-out SHA **равен заданному `candidate_sha`**, а не только workflow run.head_sha. Скопируй URL запуска, workflow name, attempt, conclusion и SHA в отдельную запись заметок/evidence. **Зелёный** = проверка прошла на этом SHA, **красный** = failure, отсутствие check = **unknown**, не pass.
11. В Settings/Notifications GitHub включи уведомления для релевантных issue/PR и проверь на тестовом PR. Уведомления о движении Project-карточки не считать гарантированными.

### После P10–P13: ничего не покупать и не включать автоматически

- **P10:** service S10 зависит от application M1/M2. Пока их нет — ожидаемый blocker. Не соглашайся на пустой `systemd unit`, который выдаёт service за готовый.
- **P11:** резервная копия `state/` без `auth/`, с тестовой процедурой restore; действительный offsite-backup будет ручным на VPS.
- **P12:** Ollama/Qwen — добровольно и позднее. Не скачивать большой model blob на боевой VPS без оценки RAM/диска.
- **P13:** Windows/macOS Actions — отдельное согласование workflows и расходов. Сами по себе Linux Docker-контейнеры не заменяют native CI.
- **P14:** updates на настоящем сервере только после backup и плана миграции.

### После P15: квалификация; затем арендуем постоянный VPS

Сначала заверши VM qualification: свежая установка, второй запуск, прерывание, reboot, ошибка сети/диска, отказ manual gate, проверка backup/restore/emergency. Если какие-то проверки `NOT RUN` — нельзя писать `production-qualified` без объяснения. Проверяй точные версии, `versions.lock.json`, подлинность manifest, checksum и подпись setup release. **VPS покупай, когда готов к deployment**; можно раньше лишь для обучения, но никакой пользы для написания P00–P15 он не обязателен.

---

## Когда установщик уже написан: на настоящем VPS, буквально шаг за шагом

**Ниже — planned команды из `deployment-walkthrough.md`. Выполнять только если приняты P15, M0 и проверен setup release.** Если реальный итоговый CLI после P15 отличается, руководствуйся квалифицированным `setup/docs/quickstart.md`, а не примерами из этого раздела.

1. **Сам арендуешь VPS:** Ubuntu 24.04 amd64, фиксированные CPU/RAM/диск, доступ к web console провайдера. Проверяешь тариф, включённый трафик, платные snapshots/backups и отключённые автоплатные опции. Для toy profile ориентир в документе 2 CPU/4 GiB/20 GiB free, для engine 4 CPU/8 GiB/80 GiB; это sizing-гипотеза, а не гарантия.
2. **Своими руками обеспечиваешь вход:** через панель провайдера добавляешь свой SSH public key; подключаешься с ПК, сверяешь SSH host fingerprint через provider console. Если логин сразу root/ubuntu — создаёшь обычного sudo-пользователя `factory` согласно reviewed bootstrap/runbook. Проверяешь **новый вход** и `sudo` во втором окне, оставляя первое открытым.
3. **Получаешь готовые файлы:** на ПК берёшь проверенный setup release P15 и M0 application release, фиксируешь SHA/checksums и сохраняешь trusted verification key. Переносишь через `scp` на VPS; **на VPS проверяешь подпись и checksum до извлечения**. Не скачиваешь непроверенный `latest` через случайный URL.
4. **S00 bootstrap:** в проверенной папке release запускаешь `bash bootstrap.sh --release-dir .`; читаешь будущий список `sudo/apt` операций и подтверждаешь только проверенный минимум. Должен появиться `~/.local/bin/factory-setup`.
5. **S01 план:** выполняешь команды ниже `init` → `preflight` → `plan`. Указываешь путь к reviewed M0 archive, profile=`supervised`, limits и paths. Результат — planned stages и ручные gates. Сначала прочитай план целиком.
6. **S02–S06 apply:** выполняешь `apply`; на остановках читаешь показанный change/diff. Для **S03** проходишь официальный Tailscale login, ставишь Tailscale на ПК/телефон, включаешь MFA/доступ, проверяешь второй SSH вход через tailnet; **только затем** разрешаешь firewall/SSH cutover. Если связь потеряна — console/rollback, не повторяй вслепую.
7. Для **S04 Docker group** отдельно подтверждаешь права, выходишь из SSH, заходишь вновь, проверяешь `docker version` и `status --refresh`, затем `resume`. Группа `docker` по возможностям близка к root, это не мелкое согласие.
8. В **S05–S06** проверяешь исходный M0 SHA/manifest, build context и Dockerfile, подтверждаешь сборку образа; конфиги и пользовательские auth/state хранилища создаются без перезаписи старых.
9. **S07 offline smoke:** используешь `verify --stage S07`, затем `smoke --provider fake --fixture toy`. Ожидается `runner_ready_offline` без модели и токенов. Если ошибки — остановись и проверь `status`/`next_action`.
10. **S08 авторизация по твоему решению:** `auth login` выдаёт device code/официальную страницу; логин выполняешь сам в браузере. Отдельно разрешаешь **один** `smoke --provider live --fixture toy`. Проверяешь `needs_review`, SHA, stop и cleanup. Доступный логин не значит, что квота имеется.
11. **S09 GitHub:** проверяешь Project и issue, сделанные ранее; для движка вручную принимаешь baseline PR в `anarchy-engine`, запускаешь Actions на exact SHA и сохраняешь evidence. CLI помогает подготовить файлы, но GitHub writes — не молчаливые.
12. **S11 эксплуатация:** запускаешь `backup create`/`backup verify`; через `scp` скачиваешь **проверенную** backup-копию в безопасное место на ПК и тренируешь восстановление на тестовой VM. Убеждаешься, что auth не входит в backup. Проверяешь аварийный `cancel --emergency` и что есть план доступа через provider console.
13. **Что пока не включать:** S10 24/7 service/unattended до M1/M2; S12 Ollama до отдельного решения и измерений; S13 Windows/macOS workflows до готового product CI; S14 upgrades до отдельного plan+backup.

**Пример planned команд (пути и flags следует сверить с принятым P15 release):**

```bash
bash bootstrap.sh --release-dir .
~/.local/bin/factory-setup init --profile supervised --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup preflight --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup plan --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup apply --config ~/.config/agent-factory/setup.json --plan ~/.local/state/agent-factory-setup/plan.json
~/.local/bin/factory-setup status --config ~/.config/agent-factory/setup.json --refresh
~/.local/bin/factory-setup gate list --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup resume --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup verify --config ~/.config/agent-factory/setup.json --stage S07
~/.local/bin/factory-setup smoke --config ~/.config/agent-factory/setup.json --provider fake --fixture toy
~/.local/bin/factory-setup auth login --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup auth status --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup smoke --config ~/.config/agent-factory/setup.json --provider live --fixture toy
~/.local/bin/factory-setup backup create --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup backup verify --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup cancel --config ~/.config/agent-factory/setup.json --emergency
```

`apply` не делает AI login/live call автоматически. После reboot/прерывания сначала `status --refresh`; при безопасном явном lock-recovery — `recover --lock-only`, затем `resume`. Не удаляй lock вручную и не делай auto-unpause.

## Конец первого этапа: что реально получится

- **После P02 + M0 + P08:** есть необходимая основа для supervised read-only Agent Runner и тестов на отдельной Ubuntu; доверенный интегрированный release установщика появится после P15, а реальная работоспособность подтверждается только smoke.
- **После P09:** GitHub Project и baseline — с ручными операциями владельца, не полноценная автоматическая очередь.
- **После P15:** квалифицированный установщик, если прошли реальные VM испытания; P15 сам по себе **не создаёт** M1/M2/оркестратор, локальный AI router или самостоятельную фабрику уровня 3.
- **Постоянно работающая автономная фабрика** потребует последующих application PR2–11 и M1/M2. **Hybrid Qwen routing** — дополнительных application PR13–17. Скрипты P00–P15 не заменяют эти разработки.

## Источники внутри репозитория

`docs/automation/CONTRACT.md`, `copilot-execution-plan.md`, `automation-plan.md`, `deployment-walkthrough.md`, `open-questions.md`, `agent-factory-guide.ru.md`. Публичные UI-ориентиры: GitHub Docs «Planning your work», «Manually running a workflow», «Reviewing your proposed changes». Сверяй UI по действующей версии GitHub.
