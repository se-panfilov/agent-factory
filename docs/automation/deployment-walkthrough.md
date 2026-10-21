# Будущая установка глазами владельца

**Все `factory-setup` и `bootstrap.sh` команды здесь — planned CLI. Сейчас этих программ нет.** После Фазы2 требуется выпущенный setup release P15 и application release M0. Этот документ не предлагает выполнять установку сегодня. Первый результат — supervised read-only runner; постоянная служба появляется позже.

## До начала

Нужны: Ubuntu24.04 amd64 VPS, доступ к console у провайдера, SSH public/private key на ПК, обычный sudo-user factory, private GitHub factory repo с reviewed setup и app releases, ChatGPT план с доступным Codex/device login, Tailscale на ПК/телефоне. На VPS не нужны API token провайдера, GitHub write-key, browser session, AI key для самой установки. Toy профиль минимум2CPU/4GiB/20GiB free; engine разумно начинать4CPU/8GiB/80GiB disk; это проектная оценка, checker может потребовать больше. Цена VPS/трафика/backups/CI подтверждается в аккаунтах вручную.

Если первый login — root/ubuntu: создайте factory и sudo по инструкции bootstrap docs, явно определив источник authorized_keys. Проверьте новый login и sudo во втором терминале, сохраните исходную сессию. Настройка SSH/firewall будет S03, не случайный побочный эффект создания пользователя. Проверьте SSH host fingerprint через console. Не используйте ssh -A.

## 1. Получить установщик без GitHub token на VPS

На ПК скачать reviewed private setup release, подпись/checksums с привязкой к известному commit. Архив локально переименовать `factory-setup-release.tar.gz`. Получить public verification key по доверенному каналу. Сверить SHA256 и подпись до извлечения. Эти ручные действия нужны один раз на выпуск, не на каждый stage.

Обычные SSH-команды (не installer; ввод адреса интерактивный):

```bash
read -r -p 'SSH target (factory@server): ' FACTORY_TARGET
scp factory-setup-release.tar.gz "$FACTORY_TARGET:factory-setup-release.tar.gz"
ssh "$FACTORY_TARGET"
```

В PowerShell вместо Bash read используйте `Read-Host` и scp/ssh с полученным значением; user tooling остаётся на ПК. Уже на VPS владелец проверяет переданный checksum и извлекает проверенный архив в отдельную папку `factory-setup-release`, читает bootstrap. Отсутствует release/M0? Остановиться здесь, пройти execution plan; не скачивать случайный установщик из интернета.

## 2. Bootstrap — S00

**Planned CLI**, в извлечённой доверенной папке:

```bash
bash bootstrap.sh --release-dir .
```

Bootstrap проверит host/UID и минимальные инструменты, покажет отдельную sudo apt операцию, установит проверенный Node в private user prefix и `~/.local/bin/factory-setup`. Не нужны shell profile/nvm sourcing. Успех: exact Node/CLI versions и receipt. При root — отказ с инструкцией входа factory; при TLS/hash mismatch — отказ без исполнения файла; при apt partial — manual repair и повтор bootstrap. Повтор сверяет уже установленные bytes.

## 3. Создать desired config и план — S01

**Planned CLI:**

```bash
~/.local/bin/factory-setup init --profile supervised --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup preflight --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup plan --config ~/.config/agent-factory/setup.json
```

Init задаёт локальный путь reviewed app archive и version lock, ожидаемые host/user, repo SHA и безопасные defaults; secrets не спрашивает. Existing config не перезаписывает. Plan пишет файл `~/.local/state/agent-factory-setup/plan.json` и показывает stages/gates/changed resources, а также неопределённые apt effects. Недостающий M0 → visible blocker S05; низкая RAM/disk → конкретный объём дефицита и exit3. Для устранения ресурсной ошибки пользователь выбирает другой тариф сам или освобождает явно просмотренные данные; installer ничего не покупает/не удаляет.

## 4. Apply — S02–S06

**Planned CLI:**

```bash
~/.local/bin/factory-setup apply --config ~/.config/agent-factory/setup.json --plan ~/.local/state/agent-factory-setup/plan.json
```

Installer по очереди ставит разрешённые пакеты, подготавливает доступ, Docker, application release и image/config. Перед sudo, Docker group и code/build trust показывает конкретный diff и отдельный gate. Изменение host/config после plan аннулирует approvals. Без TTY недостающий gate даёт exit4; глобального --yes нет.

В S03: открыть официальный Tailscale login на ПК, настроить devices/ACL, подключиться вторым SSH терминалом через tailnet и телефоном. Убедиться в console recovery; дать cutover approval. До подтверждения действует10min rollback. После независимой проверки закрыть provider public SSH в панели; проверять IPv4 и IPv6. При потере связи ждать rollback либо использовать console, не вслепую повторять apply.

В S04 после вступления в docker group CLI завершится с awaiting_manual/relogin. Выйти и открыть новую SSH-сессию. Успех: daemon доступен, no-secret Docker fixture завершён, no public published ports. Conflict существующего Docker/daemon config → exit8 с proposed diff, не uninstall.

В S05 release распаковывается/проверяется; code проекта движка не исполняется. В S06 создаются private auth/state dirs, toy и pinned agent image. Ручные изменения конфигов сохраняются; ошибка checksum/Dockerfile drift блокирует build. Успех подтверждается actual versions/schema/image inspect, не только exit apt/build.

## 5. Продолжить после любой остановки

**Planned CLI:**

```bash
~/.local/bin/factory-setup status --config ~/.config/agent-factory/setup.json --refresh
~/.local/bin/factory-setup gate list --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup resume --config ~/.config/agent-factory/setup.json
```

Status перечисляет проверенное, skipped, blocked, manual next actions. Resume заново измеряет действительность и выполняет только согласованные недостающие операции. После reboot с незавершённым lock:

```bash
~/.local/bin/factory-setup recover --config ~/.config/agent-factory/setup.json --lock-only
~/.local/bin/factory-setup resume --config ~/.config/agent-factory/setup.json
```

Lock recovery проверяет boot/process identity и owned resources; если ещё живой процесс — exit7, не delete. Частичный dpkg → owner audit/repair; partial image → inspect/cleanup только own staging; damaged config → previous/proposed diff с gate. Новый model run никогда не возникает только от resume.

## 6. Подтвердить offline readiness — S07

**Planned CLI:**

```bash
~/.local/bin/factory-setup verify --config ~/.config/agent-factory/setup.json --stage S07
~/.local/bin/factory-setup smoke --config ~/.config/agent-factory/setup.json --provider fake --fixture toy
```

Fixture tests проверяют ошибочный SHA/JSON/timeout/protocol, Docker probes — mount/limits/cleanup. Успех: `runner_ready_offline`; S08 awaiting_manual. No AI calls, AI subscription не нужна до этого места. Failed Docker cleanup → recovery_required и exit8; никакого обещания ready. Fake-provider pass не объявляется подтверждённым OAuth.

## 7. Логин и один реальный запуск — S08

**Planned CLI:**

```bash
~/.local/bin/factory-setup auth login --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup auth status --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup smoke --config ~/.config/agent-factory/setup.json --provider live --fixture toy
```

Владелец принимает supervised риск: model credential доступен agent процессу; брокера пока нет. Device code вводится только на официальной странице; не сохраняется в setup logs. Затем отдельный gate на один live запрос с timeout300s, daily budget3 и zero retry. Результат: валидный JSON `needs_review`, исходный toy SHA не изменён, контейнера нет. Это и есть первый работающий Agent Runner. `login status` сам по себе не подтверждает quota или live readiness.

Ошибка quota/auth/schema/provider → visible blocked, owner проверяет usage/login. Никакого API fallback. После обрыва SSH/перезагрузки run не воспроизводится; сначала app status/owned container reconcile, неизвестный расход сохраняется. Повторный live smoke требует нового решения. `needs_review` не означает автоматически принятую задачу.

## 8. Подключить anarchy-engine — S09

Выполнить `plan --config ~/.config/agent-factory/setup.json --stage S09`, затем `apply --config ~/.config/agent-factory/setup.json --plan ~/.local/state/agent-factory-setup/plan.json` (planned CLI). Installer получает отдельный checkout выбранного SHA, читает .nvmrc/workspaces/CI как данные, подготавливает baseline/Dependabot proposals. Владелец создаёт private Project/fields/issue, переносит run links вручную, merge baseline workflow и выполняет проверку exact SHA в GitHub. Stage фиксирует manual evidence или unknown; no CI не pass. Engine Scout — отдельный approved app run после S08, не бесплатная часть setup. Для tests используется checker без auth; отсутствие PR4 adapter блокирует только automated checker.

## 9. Эксплуатация — S11 и advanced S10

Для supervised S11 даёт status/backup/stop инструкции без пустой SQLite. Для service нужен M1/M2: после отдельных application PR переключить desired profile на service и получить новый plan/gates. S10 переносит data paused, делает backup/migration, устанавливает unit с абсолютным Node и recover before serve. При отсутствии команд — `blocked: capability_missing`, никакого успешного пустого сервиса. Unattended требует negative security и restore/reboot reports.

**Planned CLI для backup:**

```bash
~/.local/bin/factory-setup backup create --config ~/.config/agent-factory/setup.json
~/.local/bin/factory-setup backup verify --config ~/.config/agent-factory/setup.json
```

Владелец забирает verified копию на ПК через scp и тренирует restore; auth не копируется. Ошибка backup не удаляет последнюю хорошую копию. Restore требует backup ID и отдельный plan; возвращает paused состояние.

## 10. Optional/maintenance

S12/S13 добавляются только явным desired flag/selected stage. Ollama download/benchmark никогда не входит default install. Если optional failed, отчёт сохраняет готовность cloud-only и отдельный exit10. Inference disable сохраняет веса. Платформенные workflow требуют реального browser_smoke PR12: no-op не допускается.

Обновление: `factory-setup update plan --config … --release PATH` → просмотр → `update apply --config … --plan PATH`. PATH и generated план выдаёт CLI; это planned notation, не существующий файл. OS/kernel/full-upgrade отдельно в maintenance window. Не делать git pull в production tree за спиной installer.

## Аварийная остановка

**Planned CLI:**

```bash
~/.local/bin/factory-setup cancel --config ~/.config/agent-factory/setup.json --emergency
```

Ставит cancellation для setup и через app capability PAUSED/stop для известных app workers; только принадлежащие установке ресурсы. Если приложение Level1, stop также прерывает текущий worker; Level3 pause отдельно не прерывает. Если Docker/SSH умерли — console/provider shutdown; отдельно отменить GitHub Actions и отозвать credentials при утечке. Остановка VPS не отменяет уже отправленный AI запрос и не отзывает токен.

## Пример итогового отчёта (ожидаемый, не реальный)

| Возможность | После минимального пути |
|---|---|
| Bootstrap/packages/access/Docker | verified |
| Application/config/offline runner | verified |
| Live toy run | verified только после шага7 |
| Project/CI | skipped или manual/unknown до шага8 |
| Service/unattended | blocked, пока нет M1/M2 |
| Ollama/platform checks | skipped по умолчанию |
| Backup offsite | manual, пока владелец не подтвердил |

У отчёта всегда есть причины, next action, версия/дата проверки и перечень непроверенного. Он не должен заставлять читать всё исходное руководство для исправления конкретной ошибки.
