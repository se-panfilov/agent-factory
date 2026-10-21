# С чего начать: Phase 1 → Copilot → VPS

> **Важно:** архив Phase 1 содержит документацию и **16 промптов P00–P15**, но не готовый установщик. `factory-setup` и `bootstrap.sh` — **planned CLI**, не запускай их сейчас. Документ `deployment-walkthrough.md` станет практической инструкцией только после реализации P00–P15, принятия P15 qualification и наличия M0.

## Дорожка А: сейчас — написать installer с Copilot

1. **На своём доверенном компьютере** создай или открой **приватный репозиторий** AI Software Factory. Помести документы из архива в `docs/automation/` (этот starter ZIP уже раскладывает их). Не коммить `auth/`, `state/`, реальные ключи и токены. Установи `AGENTS.md`, `.github/copilot-instructions.md`, `.github/skills/implement-factory-setup/SKILL.md`; при наличии аналогичных файлов сначала сверь и объедини инструкции, не перетирай их.
2. **Открой репозиторий в Copilot Agent mode**. Первый запрос: «Реализуй только `docs/automation/copilot-prompts/00-contract-and-foundation.md`. Прочитай `AGENTS.md` и `docs/automation/CONTRACT.md`. Пиши только объявленный scope; добавь тесты и отчёт. Ничего не устанавливай на хост». Лучше отдельная ветка/PR.
3. **После каждого Pxx** прочитай diff и `setup/docs/implementation/Pxx.md`; проверь тесты и отсутствие побочных эффектов, секретов, непрошенных файлов. Прими/merge PR только после ручной проверки. Затем переходи к **следующему** промпту из `copilot-execution-plan.md`; не давай Copilot выполнить все 16 одновременно.
4. Последовательность: **P00–P02** ядро и тестовые контракты; **P03–P05** Ubuntu/SSH/Docker; **P06–P08** поставка существующего приложения, конфиги, offline+OAuth/live smoke; **P09–P11** GitHub/сервис/operations; **P12–P13** optional inference/platform; **P14–P15** upgrades, qualification, version locks, release.
5. **Параллельно, отдельной цепочкой:** подготовь фактический supervised runner как **M0 application release** по руководству `agent-factory-guide.ru.md`. P00–P15 **не создают** само приложение. P06 может разрабатываться на fake release, но настоящий VPS-run заблокирован без M0. M1/M2 отдельно понадобятся позже для service/unattended.
6. **P15:** проведи qualification на специально предоставленной одноразовой Ubuntu 24.04 amd64 VM, изучи отчёт о пройденных и непройденных испытаниях, сверяй release pins/hash/signature. Только после принятого production-qualified setup release переходи к VPS.

## Дорожка Б: после P15 + M0 — ручные действия при развёртывании

| Когда | Что ты делаешь | Что делает будущий установщик |
|---|---|---|
| **До S00** | Сам выбираешь VPS с фиксированной ценой, Ubuntu 24.04 amd64, доступом к provider console; проверяешь трафик, backup/billing, SSH fingerprint; создаёшь **не-root sudo** пользователя и проверяешь вторую SSH-сессию | Ничего не покупает и не создаёт VPS |
| **S00** | На ПК проверяешь доверенный подписанный setup release, переносишь его через `scp` на VPS, проверяешь checksum/signature и читаешь bootstrap; подтверждаешь минимальные sudo/apt операции | Запускаемый `bootstrap.sh` устанавливает зафиксированный Node и `factory-setup` |
| **S01** | Настраиваешь `setup.json`, предоставляешь reviewed **M0 app release**, оцениваешь дефицит RAM/SSD и план | `init`, `preflight`, `plan`: показывает dependency closure, риски и gates |
| **S02** | Смотришь точный список apt/privileged изменений, подтверждаешь; при dpkg/reboot blocker сначала чинишь вручную | Устанавливает и проверяет пакеты |
| **S03** | Входишь в Tailscale, проверяешь MFA/ACL, SSH *во втором терминале* и доступ с телефона; убеждаешься в provider console и таймере rollback, затем отдельно подтверждаешь firewall/SSH cutover (включая IPv6) | Настраивает доступ и проверяет, что можно безопасно закрыть публичный вход |
| **S04** | Одобряешь root-equivalent Docker group и нужные изменения daemon, **перезаходишь по SSH**, затем вызываешь `status --refresh` / `resume` | Устанавливает/проверяет Docker и ограничения ресурсов |
| **S05–S06** | Подтверждаешь origin/SHA/signature application release, содержимое Dockerfile/build и изменения существующих конфигов | Распаковывает **существующий** M0, создаёт настройки/образ и проверяет hashes |
| **S07** | Проверяешь offline отчёт (`runner_ready_offline`), нерешённые blockers | Выполняет fake/no-secret smoke без AI-вызовов |
| **S08** | Сам проходишь **Codex device login** через официальную страницу; подтверждаешь риск модели с доступом к credential и **отдельно один live вызов**, смотришь `needs_review` | Проверяет auth и запускает один ограниченный toy smoke; без auto API fallback |
| **S09** | Вручную создаёшь GitHub Project/fields/issues, проверяешь notifications/billing, просматриваешь и merge baseline workflow PR, запускаешь baseline на конкретном SHA | Подготавливает checkout и предложенные GitHub файлы, собирает evidence или unknown |
| **S11** | Забираешь **проверенную** backup-копию на свой ПК, тестируешь restore, упражняешься в emergency stop | Предоставляет backup/status/health/cancel без скрытой публикации |
| **S10** (позже) | Только после реальных M1/M2: подтверждаешь migration/service enable и отдельную unattended admission | При наличии возможностей переводит paused app в service, проверяет восстановление после reboot |
| **S12/S13** (опционально) | Сам решаешь о модели Ollama/Qwen и её ресурсах; для платформ — явно утверждаешь GitHub workflow/permissions, billing и первый dispatch | Ставит только выбранные optional компоненты; не выдаёт unavailable capability за success |
| **S14** (позже) | Проверяешь новый release, migration, backup и diff; утверждаешь обновление | Выполняет staged update/recovery, не `git pull` в работающий каталог |

### Основные planned команды (не выполнять, пока нет P15 release)

После переноса проверенного release на VPS, находясь в его каталоге, с обычным sudo-user:

```bash
bash bootstrap.sh --release-dir .
~/.local/bin/factory-setup init --profile supervised --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup preflight --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup plan --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup apply --config ~/.config/agent-factory/setup.json --plan ~/.local/state/agent-factory-setup/plan.json
```

Для ручной остановки и последующего возобновления после изменения окружения:

```bash
~/.local/bin/factory-setup status --config ~/.config/agent-factory/setup.json --refresh
~/.local/bin/factory-setup gate list --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup resume --config ~/.config/agent-factory/setup.json
```

`apply` **не** запускает автоматически платный live smoke, Ollama, GitHub writes, service или upgrades. Отдельные команды для S07/S08/S09, backup, update и отмены смотри в `deployment-walkthrough.md`. При любом blocker проверяй поле `next_action` и конкретный exit code из `CONTRACT.md` (например 4 — manual gate, 5 — отсутствующая capability, 8 — drift/recovery).

## Где искать ответ

- **Что поручать Copilot сейчас:** `copilot-execution-plan.md` и конкретный `copilot-prompts/NN-*.md`.
- **Общий технический контракт:** `CONTRACT.md`.
- **Когда делать ручные действия на VPS:** `deployment-walkthrough.md` и `automation-plan.md`, раздел «Ручные gates».
- **Что пока не существует:** `open-questions.md`, в частности Q01/M0, M1/M2 и Q02 pins.
- **Почему нет production installer:** `phase1-validation.md`; настоящие Ubuntu VM проверки ещё не выполнялись.
