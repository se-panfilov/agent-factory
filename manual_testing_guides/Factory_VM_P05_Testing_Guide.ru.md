# Проверка P01–P05 на тестовой Ubuntu 24.04 VM

**Цель:** воспроизводимо проверить bootstrap, состояние установщика, apt, SSH/Tailscale/firewall, Docker, повторное выполнение и восстановление. Это **developer/VM qualification**, а не утверждение о выпуске production installer P15.

**Откуда требования:** приложенный пакет `Archive(1).zip`: `copilot-prompts/01-bootstrap.md` … `05-docker-host.md`, `CONTRACT.md`, `automation-plan.md`, `deployment-walkthrough.md`. В руководстве 4.1 и этих промптах установщик ещё *проектируется*, поэтому наличие файлов и команд нужно проверять по фактической реализации после P05.

> **Операционная безопасность:** команды с заголовком **НА MAC** выполняются в Terminal macOS; **В UBUNTU** — после `multipass shell factory-lab`. Не вводи команды Ubuntu с `sudo` в терминале Mac. Не копируй в VM личный home, ключи GitHub/ChatGPT, `.env`, production-базы, SSH-agent или рабочие репозитории целиком. Ключ ниже создаётся исключительно для VM.

## 0. Какую VM можно использовать

На **Mac**:

```bash
uname -m
sw_vers -productVersion
sysctl -n hw.memsize
```

- `x86_64`: Intel Mac, Multipass подходит для **Ubuntu 24.04 amd64**.
- `arm64`: Apple Silicon. Multipass выдаст **Ubuntu arm64**, не amd64. На нём можно проверить общие контракты, но `S00`, требующий `amd64`, должен **отклонить** среду. Для подтверждения полного P01–P05 нужен **Ubuntu 24.04 amd64** на временном x86 VPS с web console/snapshot или x86_64 UTM emulation. Не пытайся переименовать ARM в AMD64 или принудительно выключить проверку.
- Рекомендуемые ресурсы для Intel Mac с достаточным запасом: **4 vCPU / 8 GiB RAM / 60 GiB диск**. Если у Mac лишь 8 GiB физической RAM, не выделяй гостю 8 GiB: используй меньший профиль для базовых проверок, а ресурсозависимые отметь NOT RUN. Диск VM виртуальный, но свободное место на Mac всё равно нужно.
- Нужна поддерживаемая версия macOS (актуальная документация Multipass указывает macOS 14+).

Если использовать одноразовый **amd64 VPS**, пункты про `multipass` заменяются кнопками провайдера «Create VM / Console / Snapshot / Reinstall»; остальная часть внутри Ubuntu совпадает. На VPS предусмотрительно открой provider console *до* сетевых экспериментов.

## 1. Установка Multipass и загрузка Ubuntu

**НА MAC**

1. Зайди на <https://canonical.com/multipass/install>, выбери macOS и установи официальный `.pkg`. Выдай разрешение администратора. Убедись, что процесс Multipass запущен.
2. Открой **Terminal** и проверь:

```bash
multipass version
multipass find
```

3. Создай **отдельную именную VM** (не `primary`, который может автоматически монтировать домашний каталог):

```bash
multipass launch 24.04 --name factory-lab --cpus 4 --memory 8G --disk 60G
multipass list
multipass info factory-lab
```

Multipass самостоятельно скачивает официальный cloud image Ubuntu 24.04 и создаёт диск. Скачивать ISO отдельно **не нужно**.

4. Открой терминал гостя:

```bash
multipass shell factory-lab
```

**В UBUNTU**

```bash
cat /etc/os-release
uname -m
dpkg --print-architecture
id -un
id -nG
free -h
df -h /
```

**Ожидается:** `Ubuntu 24.04`, `ubuntu`, архитектура `x86_64`/`amd64` для Intel. Если `aarch64`/`arm64`, продолжай только платформонезависимые проверки и фиксируй **S00 AMD64 = BLOCKED**.

Не переходи к установке Docker на этом шаге: нам нужен нетронутый baseline для проверки **самого** установщика P05.

## 2. Настроить независимый SSH-доступ для экспериментов

`multipass shell` — канал управления VM, который пригодится, даже если SSH в госте закрыт. Для проверки SSH нужен второй независимый способ подключения из Terminal.

### 2.1. Подготовка отдельного ключа

**НА MAC (в другом окне Terminal):**

```bash
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
ssh-keygen -t ed25519 -f "$HOME/.ssh/factory-vm-lab" -C "factory-vm-lab"
multipass transfer "$HOME/.ssh/factory-vm-lab.pub" factory-lab:/home/ubuntu/factory-vm-lab.pub
```

`ssh-keygen` попросит пароль для *тестового* ключа; можно поставить passphrase. Не перезаписывай одноимённый файл, если он уже есть. Приватный ключ остаётся на Mac.

**В UBUNTU:**

```bash
sudo apt update
sudo apt install -y openssh-server
sudo systemctl enable --now ssh
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
cat "$HOME/factory-vm-lab.pub" >> "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
rm "$HOME/factory-vm-lab.pub"
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Запомни SSH host key fingerprint из последней команды. Это способ проверить, что подключаешься к нужной VM.

### 2.2. Первый и второй SSH-вход

**НА MAC:**

```bash
multipass info factory-lab
```

Найди поле `IPv4`. Скопируй адрес и введи его в переменную (команда сама попросит IP):

```bash
printf "IPv4 из multipass info: "
read -r VM_IP
ssh -i "$HOME/.ssh/factory-vm-lab" -o IdentitiesOnly=yes "ubuntu@$VM_IP"
```

При первом подключении сравни fingerprint в SSH prompt с тем, который показала Ubuntu. Если не совпадает — **не соглашайся**.

В открывшемся SSH окне:

```bash
hostname
whoami
```

Ожидается `factory-lab` и `ubuntu`.

**Не закрывай первое SSH-окно.** Открой ещё одно окно Terminal на Mac, повтори `printf ...; read -r VM_IP`, заново введи тот же IP и выполни `ssh ...`. Переменная `VM_IP` не переносится между окнами. Оба входа должны работать одновременно. Дополнительно `multipass shell factory-lab` должен оставаться доступным из третьего окна.

Если SSH до IPv4 недоступен из-за режима сетевого backend, **не меняй вслепую firewall Mac**. Проверь `multipass info`, `sudo systemctl status ssh` из `multipass shell`, справку Multipass networking. Отметь SSH connectivity как BLOCKED, пока не настроена доступная сеть.

## 3. Чистый snapshot до вмешательства установщика

Выйди из обоих SSH-окон и из гостя командой `exit` (саму VM это не выключает).

**НА MAC:**

```bash
multipass stop factory-lab
multipass snapshot factory-lab --name clean-ssh
multipass start factory-lab
multipass list --snapshots
multipass info factory-lab.clean-ssh
```

**Ожидается:** `multipass list --snapshots` показывает snapshot `clean-ssh` у instance `factory-lab`, а `multipass info factory-lab.clean-ssh` выводит его свойства. В некоторых версиях Multipass существует отдельная команда `multipass snapshots`, но не во всех; не используй `multipass snapshots factory-lab` для проверки. Если флаг `list --snapshots` недоступен в установленной версии, попробуй `multipass info factory-lab --snapshots` и `multipass help list`, затем проверь доступность snapshot командой `multipass info factory-lab.clean-ssh`. Внутри VM есть SSH-доступ, но нет Docker, Tailscale и установленной фабрики. Snapshot работает только для остановленного instance и при поддержке выбранного Multipass backend.

Если snapshot недоступен — не отмечай его PASS. Создай заново тестовую VM для каждого разрушительного сценария либо используй disposable VPS с проверенным snapshot/reinstall.

### Как восстановиться позже

**НА MAC:**

```bash
multipass stop factory-lab
multipass restore factory-lab.clean-ssh
multipass start factory-lab
multipass shell factory-lab
```

`restore` спросит, сохранить ли ещё один snapshot перед заменой. Это нормально. Состояние *после* `clean-ssh` будет потеряно. **Не используй `--destructive` без осознанной причины.** После восстановления IP может измениться: заново узнай его через `multipass info`. Если ранее подключал Tailscale, удали старую VM из панели tailnet, чтобы не оставлять осиротевшее устройство.

## 4. Передать исходники установщика, не передавая секреты

**Важно:** после P05 у тебя пока может не быть P15 signed production release и `versions.lock`. Поэтому сначала проводятся **development VM tests**, а не завершается полноценный S00–S04 deployment через финальный bootstrap.

**НА MAC:** открой каталог своего приватного репозитория `agent-factory`. Следующие команды выполняются **из его корня**:

```bash
git status --short
git rev-parse HEAD
```

Убедись, что P00–P05 уже приняты; незакоммиченные изменения не должны попадать в тестовую поставку.

Сделай архив из файлов выбранного commit (без `.git`, `auth`, `state` и незакоммиченных файлов):

```bash
git archive --format=tar.gz --output="$HOME/factory-lab-source.tar.gz" HEAD
multipass transfer "$HOME/factory-lab-source.tar.gz" factory-lab:/home/ubuntu/factory-lab-source.tar.gz
```

**В UBUNTU:**

```bash
mkdir -p "$HOME/factory-src"
tar -xzf "$HOME/factory-lab-source.tar.gz" -C "$HOME/factory-src"
cd "$HOME/factory-src"
ls -la
ls docs/automation
ls setup
```

`git archive` не переносит историю Git и незакоммиченные файлы. Если исходный проект ещё не существует целиком, остановись и проверь merge P00–P05 — не компенсируй это копированием личной директории со всеми секретами.

## 5. Как запускать тесты P01–P05 **до** P15

Есть две независимые ветви проверки.

### Ветвь А. Детерминированные тесты кода без изменения Ubuntu

В `setup/` найди реальные scripts (`package.json`, `setup/README.md`, `setup/docs/implementation/P01.md` … `P05.md`). **Не угадывай entrypoint и не запускай весь `npm test`, не проверив, что он действительно изолирован от системных мутаций.** Согласно спецификации P01–P05, обычные unit/integration tests должны пользоваться fake adapters, а live VM tests запускаются отдельно.

На чистой VM для development testing, *при необходимости* временно установи Node 24 из проверенного nvm release, **но не записывай это как проверку S00 bootstrap**:

```bash
sudo apt install -y git curl ca-certificates xz-utils
if [ ! -d "$HOME/.nvm" ]; then
  git clone --branch v0.40.8 --depth 1 https://github.com/nvm-sh/nvm.git "$HOME/.nvm"
fi
. "$HOME/.nvm/nvm.sh"
nvm install 24
node --version
npm --version
```

Далее, если `setup/package.json` действительно существует и его `scripts` проверены:

```bash
cd "$HOME/factory-src/setup"
node -p 'JSON.stringify(require("./package.json").scripts, null, 2)'
```

По отображённым действительным скриптам запусти `npm ci`, `npm test`, `npm run typecheck` **только если такие scripts существуют и их содержание не вызывает `sudo`/apt/Docker live mutations**. Не объявляй отсутствие скрипта «падением установки»: это дефект/незавершённость PR, подлежащие исправлению Copilot.

Реальные ожидаемые unit cases P01–P05: неверная архитектура, bad checksum, partial installation, второй запуск, stale checkpoint, двойной lock, отказ manual gate, dpkg lock, чужой daemon config, expired rollback, неправильные permissions.

### Ветвь Б. Host-mutating VM qualification

**Не начинай её просто через `npm test` или неподписанный shell из репозитория.** Используй только отдельные команды `setup/docs/bootstrap.md`, `setup/docs/access-recovery.md`, `setup/docs/docker.md` и VM test entrypoints, которые Copilot фактически реализовал в P01–P05 и которые ты просмотрел как код.

Перед каждым изменением:

1. Проверь `multipass info factory-lab` и `multipass info factory-lab.clean-ssh` (snapshot `clean-ssh`).
2. Подтверди, что команда выполняется в `factory-lab`, а не на Mac.
3. Выпиши действие, требуемые права, ожидаемый результат и способ rollback.
4. Проверь вывод `plan`/diff/gate. Если production release ещё отсутствует, **не обходи проверку подписи фиктивным ключом** и не маркируй production installation PASS.
5. После выполнения измерь **фактическую систему**, а не только полученный exit code.

Обязательный порядок: `P01 bootstrap` (только если есть проверяемый development bundle) → `P02 state/plan` → `P03 packages` → `P04 access` → `P05 Docker`. Для стадий, которые ещё нельзя выполнить из-за зависимостей P15, статус **BLOCKED / NOT RUN** с причиной, а не fake PASS.

### Конкретные проверки установленных ресурсов

**В UBUNTU** после соответствующего этапа:

```bash
cat /etc/os-release | grep -E '^(NAME|VERSION_ID|VERSION_CODENAME)='
dpkg --print-architecture
node --version
npm --version
command -v git
command -v curl
sudo systemctl is-active ssh
sudo systemctl is-active docker
docker version
docker compose version
id -nG
sudo ss -lntp
free -h
df -h /
```

- `node` 24 должен быть именно из **контролируемого установщиком prefix** после действительного S00; если стоит только вручную поставленный nvm — S00 **не проверен**.
- `docker version` до P05 закономерно не работает; после P05 должен показывать daemon. Если отказ из-за группы `docker`, открой **новую** SSH-сессию и снова запусти; не делай `chmod 666 /var/run/docker.sock`.
- `sudo ss -lntp`: не должно быть публичных слушателей Docker API `2375/2376` или Ollama `11434`.

После проверенного P05:

```bash
docker run --rm hello-world
docker ps -a
sudo systemctl is-enabled docker
```

**Ожидается:** hello-world завершается, не осталось чужих/зависших worker-контейнеров; Docker переживает reboot. Если P05 делает собственный no-secret probe, сравни его результат с наблюдением.

## 6. Сетевая проверка S03: сначала доступ, потом firewall

У этой операции самый высокий риск. **Для проверки собственного P04 используй его gate+rollback реализацию.** Далее — команды для *понимания и ручной диагностики* VM; они **не подменяют тест автоматического rollback P04**.

### 6.1. Проверка Tailscale

**НА MAC:** установи официальный Tailscale-клиент с <https://tailscale.com/download/mac> и войди в свой tailnet; для будущего телефона используй Tailscale app. Не надо открывать порты на роутере.

**В UBUNTU (одноразовая VM):** при самостоятельной диагностике (если P04 не делает установку сам) используй официальный repo Ubuntu Noble:

```bash
sudo install -d -m 0755 /usr/share/keyrings
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list | sudo tee /etc/apt/sources.list.d/tailscale.list >/dev/null
sudo apt update
sudo apt install -y tailscale
sudo tailscale up
tailscale status
tailscale ip -4
```

Открой показанную **официальную** ссылку авторизации в браузере Mac. В Tailscale admin console → **Machines** должна появиться новая VM. В госте `tailscale ip -4` выдаст tailnet IPv4 обычно `100.x.y.z`.

**НА MAC:** подключись через этот tailnet IP, используя уже созданный SSH key:

```bash
printf "Tailnet IPv4 из tailscale ip -4: "
read -r TS_IP
ssh -i "$HOME/.ssh/factory-vm-lab" -o IdentitiesOnly=yes "ubuntu@$TS_IP"
```

Если не работает, проверь, что **Mac тоже вошёл в тот же tailnet**, ACL разрешает SSH, Tailscale подключён в обеих средах, а порт 22 слушает внутри Ubuntu. Не включай `tailscale set --ssh` без отдельного решения: обычный OpenSSH через Tailscale уже достаточен.

### 6.2. Правильный порядок включения UFW в тестовой VM

**В UBUNTU через `multipass shell` (консоль восстановления):**

```bash
sudo ufw status verbose
sudo ufw allow 22/tcp
sudo ufw allow in on tailscale0 to any port 22 proto tcp
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable
sudo ufw status numbered
```

`ufw enable` попросит подтверждение. Сначала разрешены **оба** пути SSH — обычный и Tailscale. Теперь с Mac проверь **оба** соединения в отдельных окнах и сохрани открытым `multipass shell`.

**Только после успешного tailnet SSH** в тестовой VM можно упражняться в ограничении старого входа:

```bash
sudo ufw delete allow 22/tcp
sudo ufw status numbered
```

Проверь: SSH через `TS_IP` **работает**, SSH через исходный `VM_IP` теперь **не должен открывать новое соединение** (старое может остаться из-за conntrack). Снова подключайся через Tailscale. Если даже Tailnet закрылся, открой `multipass shell factory-lab` с Mac и восстанови:

```bash
sudo ufw allow 22/tcp
sudo ufw allow in on tailscale0 to any port 22 proto tcp
sudo ufw status numbered
```

Если P04 запланировал **автоматический rollback через таймер**, тестируй этот механизм **отдельно**: выдай его manual gate, временно имитируй непрохождение второй независимой проверки и убедись, что по истечении установленного времени безопасный доступ восстановлен. Наличие `multipass shell` доказывает только *ручную спасательную консоль*, **не** работоспособность таймера rollback.

**Важно:** Docker publishing может обходить отдельные правила UFW; не проверяй отсутствие публичного контейнерного доступа только `sudo ufw status`. У P05 должны быть отдельные проверки Docker port publishing/netfilter. На реальном VPS добавится firewall **у провайдера**, который здесь не моделируется.

## 7. Проверить idempotency, ошибку и восстановление

### 7.1. Повтор без изменений

Выполни разрешённый `verify/status --refresh` для реализованных стадий. Затем повторно запусти **тот же одобренный plan** (если developer CLI и gates позволяют). Сравни:

```bash
node --version
docker version
docker ps -a
sudo systemctl is-active docker
sudo ufw status numbered
```

Ожидается `already verified`/no-op, **без новых** SSH правил, дополнительных скачиваний/перезаписи конфигов, второго Docker daemon, второго пользователя или новых платных ресурсов. **Без официально подтверждённого CLI нельзя просто угадывать команды и вызывать `apply` наугад.**

### 7.2. Ошибка до побочного действия

Через fake/mock tests заставь P01 получить неверный checksum, P03 — занятый `dpkg` lock, P04 — denied owner gate, P05 — foreign daemon config. Для каждого ожидается blocked с конкретным reason/next action **до** опасного изменения. Не ломай реальный apt cache и не убивай dpkg для симуляции.

### 7.3. Ctrl+C после старта, но не во время apt/dpkg

Только если PR предоставляет предсказуемую injection-point в **собственном staging/download** (не apt/sshd!), запусти соответствующий VM-test, прерви `Ctrl+C`; затем проверь, что не осталось чужих изменений и выполняется безопасный `status --refresh`/`resume`. Для настоящих системных настроек и неверифицированного кода используй **fake integration tests**, не произвольный `kill -9` посреди установки Docker.

### 7.4. Reboot

**НА MAC:**

```bash
multipass restart factory-lab
multipass info factory-lab
multipass shell factory-lab
```

**В UBUNTU:**

```bash
uptime
sudo systemctl is-active ssh
sudo systemctl is-active docker
docker version
sudo ufw status numbered
tailscale status
```

Docker/Tailscale могут отсутствовать, если стадия не устанавливалась. После восстановления снова проверь новый SSH вход с Mac, `status --refresh` и `resume` в рамках **реализованного, принятого** CLI. Если старый checkpoint говорит verified, а компонент исчез, должно быть drift/blocked — не зелёный результат.

### 7.5. Snapshot restore = гарантированная чистота следующего эксперимента

После серии испытаний выполни восстановление `clean-ssh` по разделу 3 и проверь:

```bash
docker --version
command -v tailscale || true
sudo ufw status
```

После restore Docker/Tailscale обычно должны отсутствовать (если их не было в clean-ssh). Тогда можно повторить тест с нуля. **Прежде чем restore**, скопируй санитизированные записи тестирования с VM на Mac через `multipass transfer`, если они нужны.

## 8. Результаты: что записать после каждого эксперимента

В приватной заметке или `docs/testing/VM-P05-report.md` **без credential и чувствительных журналов**:

| ID | Проверка | PASS / FAIL / BLOCKED / NOT RUN | Доказательство |
|---|---|---|---|
| VM-01 | Ubuntu 24.04 и x86_64/amd64 | | `os-release`, `dpkg` |
| VM-02 | Создание/доступ `multipass shell` | | `multipass info` |
| VM-03 | Второй SSH-login | | два независимых терминала |
| VM-04 | Снимок + восстановление | | snapshot name, наблюдение |
| P01 | Bootstrap pinned release | | версия, hash, receipt |
| P02 | Plan/state/recovery | | unit+integration, actual status |
| P03 | apt/idempotency | | пакеты/versions, повтор |
| P04 | Tailscale/SSH/cutover/rollback | | два SSH пути, timer evidence |
| P05 | Docker/permissions/no public API | | `docker version`, `hello-world`, ss |
| RES-01 | Reboot + observed drift/reconcile | | status до/после |
| NEG-01 | 4 негативных fixture case | | test output/reason |

Пиши **PASS** только там, где реально получил доказательство. Если `arm64`, `P01/Ubuntu amd64` = **BLOCKED**, даже если Node и Docker вручную поставились. На локальной NAT VM нельзя засчитывать проверку firewall у будущего VPS/provider console: её стоит отдельно повторить на одноразовом удалённом amd64 VPS до production.

## 9. Удаление тестовой среды

1. Сначала скопируй нужные **санитизированные** отчёты наружу; приватный SSH-ключ тестовой VM в постоянную фабрику не переносится.
2. Если подключал Tailscale: в <https://login.tailscale.com/admin/machines> найди `factory-lab` и удали устройство. Можно выполнить в госте `sudo tailscale logout`, но это не заменяет ревокацию в admin-console после уничтожения VM.
3. **НА MAC**, только если VM больше не нужна:

```bash
multipass stop factory-lab
multipass delete --purge factory-lab
multipass list
```

`delete --purge` разрушителен — убедись, что указан **только** `factory-lab`. Не выполняй глобальный `multipass purge`, если у тебя есть другие VM, помеченные как deleted.

## Что считать итогом

- **Локальный Intel Mac / Ubuntu amd64:** можно подтвердить реальное окружение, SSH, Tailscale, UFW, Docker, а реализованные и допущенные installer stages — по фактическим VM evidence.
- **Apple Silicon:** инфраструктурные уроки и переносимые тесты, но **не квалификация amd64 bootstrap**.
- **После P05:** ещё **НЕ** финальный production-ready installer. Полная сборка, доверенные pins, release signature и comprehensive qualification относятся к **P15**, а существующий application release — к **M0**.

## Источники и пределы

Документы проекта: `copilot-prompts/P01–P05`, `CONTRACT.md`, `automation-plan.md`, `deployment-walkthrough.md`, `agent-factory-guide.ru.md` из архивного пакета. Часть ошибок пока формально определена только как acceptance в промптах; **реальный интерфейс и команды являются продуктом выполнения P00–P05 и не могут быть гарантированы до review**.

Официальные инструкции:
- Multipass: <https://canonical.com/multipass/docs/latest/how-to-guides/install-multipass/>
- Multipass snapshots: <https://canonical.com/multipass/docs/latest/reference/command-line-interface/snapshot/>
- Multipass restore: <https://canonical.com/multipass/docs/latest/reference/command-line-interface/restore/>
- Ubuntu Docker Engine: <https://docs.docker.com/engine/install/ubuntu/>
- Tailscale Ubuntu: <https://tailscale.com/docs/install/linux>
- Tailscale apt packages: <https://dl.tailscale.com/stable/>
