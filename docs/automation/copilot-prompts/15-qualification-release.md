# P15. Интеграционная приёмка, release lock и quickstart

## 1. Роль

Ты senior TypeScript/DevOps engineer и автор надёжных установщиков. Работай последовательно одним PR, соблюдая AGENTS.md текущего репозитория.

## 2. Цель

Реализовать интеграционная приёмка, release lock и quickstart для stage S00–S14. Это конкретное implementation-задание, не просьба дать советы. Предоставь полный рабочий код, meaningful tests и документацию в перечисленных файлах; обязательное поведение не заменять TODO, псевдокодом или no-op success.

## 3. Контекст

Архитектура: приватный agent-factory repo, Ubuntu24.04 VPS; TypeScript/Node24; control plane на host, Docker worker/checker, SQLite только в развитом приложении. Начало — supervised read-only Codex Runner с ChatGPT auth, one LLM, daily3, timeout300. Docker socket/GitHub write-key/home не монтируются worker; checker не получает AI auth. Установщик детерминированный и не вызывает модели для решений. Application PRs guide0–18 отдельны от installer PR P00–P15. Cloud-only default, hybrid/platforms optional. Все generation/installation scripts реализуются в этой Фазе2; этот prompt не разрешает автоматически запускать их на настоящем сервере.

Перед кодом прочитай `docs/automation/CONTRACT.md` **FACTORY-SETUP-CONTRACT 1.0.0**, `docs/automation/automation-plan.md`, `docs/automation/automation-architecture.md`, `docs/automation/automation-analysis.md` и `docs/automation/agent-factory-guide.ru.md` (редакция4.1, исходная4 рядом). Если пакет ещё лежит в корне, перенеси/подключи его по execution plan P00, не ищи прошлый чат. При конфликте guide и обязательных F01–F15 применяй уточнения4.1; при конфликте интерфейса с CONTRACT останови именно конфликтующую часть, перечисли требуемое решение. Не полагайся на память Copilot.

## 4. Входные данные

Вход: все merged P00–P14, M0 application release для actual MVP end-to-end, M1/M2/M3/M4 если release заявляет advanced features; provided disposable Ubuntu24.04 amd64 host от владельца. Без host VM qualification NOT RUN, не выпустить production-qualified tag.

C01–C11 обязательны. Используй фактические repository files и pinned manifest; для tests synthetic pins должны быть явно отделены от production. Никакие credentials не требуются для unit/integration.

## 5. Выходные артефакты

setup/tests/vm/; setup/docs/{quickstart,troubleshooting,release,qualification}.md; setup/release packaging tooling; setup/versions.lock.json; setup/release-manifest.schema.json; CI setup checks; coherent integration fixes.

Также `setup/docs/implementation/P15.md` с фактическим отчётом. Изменяй только этот scope, static registry добавь одну регистрацию после предыдущих merged PR. Shared files/package-lock правь последовательно, минимальным diff. Не перезаписывай стороннюю работу.

## 6. Функциональные требования

Собери целостный installer release с compiled CLI/deps, bootstrap, schemas/templates/keyring и version lock; dependencies без npm install на VPS для самого CLI. Разреши точные Node24 patch/Docker/Tailscale/Codex/base/optional pins из официальных источников, validate signatures/digests; не fabricate unavailable pins. Existing guide exact versions лишь кандидаты. Freeze release only после compatibility tests. Добавь unit/integration suite в существующий CI без paid resources; VM harness отдельный opt-in с supplied disposable host marker, never auto provisioning. Проведи/подготовь все C11 сценарии и честно запиши какие реально запускались. Self-contained quickstart с clean/root-or-ubuntu path, scp private archive, bootstrap/CLI, all gates/manual auth/offline/live status. Troubleshooting код→причина→конкретный безопасный next step. Финальная согласованность registry/dependencies/exit codes/paths и два tabletop сценария.

Stage API из C06: observe → plan → gated apply → verify → receipt. Stage никогда не записывает checkpoint напрямую. Проверь prerequisites перед любым побочным эффектом и actual resources после него. Для manual/development blocker верни точный code/next_action, не generic failure и не green success.

## 7. Нефункциональные требования

Идемпотентность: второй запуск сравнивает observed hashes/versions и не дублирует ресурсы. Возобновление: intent до эффекта; ownership по installation_id/operation_id; после crash сначала observation. Observable sanitized JSON/events, bounded stdout/stderr и timeout. Не менять unowned resources, user-edited config и installed versions скрытно. No AI decisions. Нет новых библиотек без обоснования; используй Node builtins/существующие Ajv/test framework. Pure logic отделена от spawn/FS/network; production adapters injectable для тестов.

## 8. Error handling

Недоступны upstream pins/VM/M0; unresolved service milestones; sources противоречат; tests timeout; packaging пропустил template/dependency; keys rotated. Блокировать только соответствующую qualification, сообщить exact blockers. Не переписывать архитектуру для зелёного CI.

C03 exit codes, C10 retry limits: GET/download максимум3 попытки/180s, TLS/signature/auth/mutation без auto retry. Event содержит operation_id, public code, next_action; secrets не содержится ни в stdout, ни в stderr, ни в checkpoint. Cleanup failure →8 и запрет дальнейших опасных действий. Не трактуй все nonzero как transient.

## 9. Corner cases

Обязательно обработай применимые для этого PR: interruption между effect и receipt; reboot; state says verified/resource absent; resource exists/state absent; wrong version; changed config; symlink/traversal; ENOSPC; revoked/stale approval; duplicate installer; inaccessible Docker/systemd; root vs owner UID; unsupported platform. Неприменимые сценарии перечисли в отчёте с причиной, не изображай тестирование. Конкретные случаи раздела8 обязательно покрыть fixtures.

## 10. Security constraints

C09/C10 обязательны: user CLI, только scoped sudo; argv shell=false; trusted binaries/env; no global --yes; no arbitrary shell от issue/config. Worker без socket, GitHub keys, host home, privileged/host network; checker без model credentials. No public Docker/Ollama API; no auto paid resource/fallback/merge/release. Desired policies вне worker write mounts. Не исполняй agent-modified installer/Dockerfile/scripts без новой reviewed release. Не выводи credentials при ошибках теста.

## 11. CLI contract

Реализуй только принадлежащие этому PR части C02 для S00–S14; не изобретай альтернативные flags. Все команды требуют `--config PATH`, кроме bootstrap и --help/--version. `plan --stage ID` показывает prerequisite closure. `apply --plan PATH` проверяет plan hash и gates. `resume` не снимает application pause и не replay live run. `verify/status --refresh` по умолчанию без AI. Состояния C07, exit codes C03, один JSON envelope stdout, progress stderr. Если command ещё зависит от другого PR — точный unsupported/blocked, не фиктивная реализация.

## 12. Dependencies

Installer PR prerequisites: **P14**. Application milestones из входов обязательны только для фактического соответствующего deployment; отсутствие их не повод писать приложение внутри installer. Не реализуй заодно будущий orchestrator, publisher, runtime или collector. Ознакомься с integration contracts предыдущих merged PR; если они отсутствуют — сообщи blocker до изменения общего API.

## 13. Testing requirements

Unit: success/negative validators и чистая decision logic этого PR; используй injected clock, проверяй retry count и deadline. Integration: временные dirs, mock CommandRunner/HTTP и реальные fs atomic behaviours; assertions проверяют конечные resources/absence forbidden effects, а не только вызов mocked функции. Добавь crash point before/after side effect, drift, duplicate run, denied gate и secret marker test. Набор не вызывает sudo, AI, GitHub writes, Docker daemon или apt на текущей машине. Отдельный VM scenario описывает реальные probes и ожидаемые результаты; запуск только supplied disposable Ubuntu и explicit owner разрешение. P15 собирает общую qualification, но каждый PR поставляет собственные fixtures. `npm test` не запускает VM tests.

## 14. Acceptance criteria

Unit+integration pass; настоящие VM fresh/second/interrupted/reboot/partial config/disk/no sudo/wrong version/network/gates/optional failure/emergency/restore pass для заявленных features. No-op second run observed; все 16 prompt outcomes integrated. Release архив проходит checksum/signature и safe extraction; clean VPS использует минимальные planned commands без secret transport в argv. Live call отдельно owner-approved; offline release label честный.

Typecheck и относящиеся tests должны фактически пройти в доступной безопасной среде. Неисполненные Docker/VM/OAuth/CI проверки отмечаются NOT RUN и блокируют соответствующую capability admission. No required TODO/no-op stub. Документация, CLI help и error next actions согласованы с CONTRACT1.0.0.

## 15. Что запрещено

Не объявлять mocks как VM proof; не создавать VPS/paid CI автоматически; no fake hashes/TODO production pins; не закрывать required failure сценарии skipped=true; не менять CONTRACT без review.

Дополнительно: не менять архитектуру guide/contract самовольно, не скрывать destructive operation в cleanup, не выполнять установку на машине разработчика, не тестировать real secrets, не имитировать pass заранее записанным отчётом, не писать независимую копию shared utility.

## 16. Отчёт о выполнении

В `setup/docs/implementation/P15.md` и итоговом ответе перечисли: изменённые файлы/поведение; команды tests и фактические результаты; какие VM/OAuth/AI/CI шаги не выполнялись; обработанные failure cases; remaining blockers; новые dependencies с причиной; security-sensitive diff; совместимость CONTRACT1.0.0 и prerequisites следующего PR. Отдельно укажи `ready for code review`, `offline verified` и `production qualified`: это разные утверждения. Не переходи к следующему prompt автоматически и не публикуй/merge PR без поручения владельца.
