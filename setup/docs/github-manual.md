# S09 GitHub manual steps (no automatic writes)

Этот документ описывает только ручные действия для S09. Установщик в P09 **не делает GitHub writes**: он лишь готовит локальный checkout по SHA и proposal-файлы.

1. **Создайте issue для baseline в factory-репозитории.**
   - Откройте `Issues` → `New issue`.
   - Название: `S09 baseline for <owner/repo>@<sha>`.
   - В тело добавьте:
     - target repository;
     - exact target SHA (40 hex);
     - путь к локальному evidence (`~/.local/state/agent-factory-setup/s09-target-inventory.json`);
     - owner note path (`s09-owner-note.json`), если используете.

2. **Создайте/настройте Project Board и поля.**
   - `Projects` → `New project` (Table).
   - Добавьте поля:
     - `Target SHA` (text),
     - `Baseline CI` (single select: `unknown`, `pass`, `fail`),
     - `Evidence` (text/url),
     - `Manual Gate` (single select: `pending`, `approved`, `blocked`).
   - Добавьте issue из шага 1 в проект и заполните `Target SHA`.

3. **Проверьте notifications и rulesets (без self-review deadlock).**
   - В `Settings` → `Notifications` включите уведомления по workflow failures.
   - В branch protection/rulesets убедитесь, что правило review не блокирует вас в сценарии единственного владельца:
     - либо есть другой reviewer,
     - либо используется ручной merge после owner-approved gate.
   - Не включайте авто-merge/авто-dispatch для этого шага.

4. **Сделайте PR с baseline workflow proposal.**
   - Источники proposal после S09:
     - `~/.local/state/agent-factory-setup/s09-proposals/factory-baseline.proposed.yml`
     - `~/.local/state/agent-factory-setup/s09-proposals/dependabot.proposed.yml`
   - Скопируйте их в target repository:
     - `.github/workflows/factory-baseline.yml`
     - `.github/dependabot.yml`
   - Создайте ветку и PR вручную.
   - В описание PR добавьте exact SHA и ссылку на issue/Project item.

5. **Запустите workflow_dispatch вручную.**
   - В PR `Actions` → workflow `factory-baseline` → `Run workflow`.
   - Передайте `target_sha` = exact SHA из S09.
   - Дождитесь завершения и скачайте artifact `checkout-evidence`.

6. **Проверьте реальный checkout SHA.**
   - В job logs найдите шаг `Confirm exact SHA binding`.
   - Убедитесь, что:
     - `actual_sha == target_sha`,
     - значение соответствует `s09-target-inventory.json.target_sha`.
   - Если job `missing/draft/skipped`, статус baseline фиксируется как `unknown`, не `pass`.

7. **Сохраните evidence в setup state.**
   - Сохраните owner note в `~/.local/state/agent-factory-setup/s09-owner-note.json`.
   - Сохраните collector evidence в `~/.local/state/agent-factory-setup/s09-collector-evidence.json`, например:
     ```json
     {
       "ci_status": "passed",
       "verification": "verified",
       "workflow_url": "https://github.com/<owner>/<repo>/actions/runs/<id>",
       "artifact": "checkout-evidence"
     }
     ```
   - Допустимые `ci_status`: `passed`, `failed`, `draft`, `skipped`, `missing`.
   - S09 recorder всегда трактует `draft/skipped/missing` как `unknown`.
