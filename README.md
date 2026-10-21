# AI Software Factory — implementation workspace starter

This is a **documentation + agent-instructions repository starter**, not a running factory or installer.

Начни с [пошагового маршрута](docs/automation/START-HERE.ru.md).

- Реализация installer: `docs/automation/copilot-execution-plan.md` (P00–P15).
- Стандарты кода/безопасность: `AGENTS.md`, `.github/copilot-instructions.md`, `.github/skills/implement-factory-setup/SKILL.md`.
- До настоящего VPS deployment нужны **P15 qualified setup release** и **M0 application release**.
- Команды из `docs/automation/deployment-walkthrough.md` пока **planned**, не исполняемые.

## Application foundation (M0.1)

`setup/` остаётся отдельным installer-workstream. Для application milestone M0.1 добавлена
локальная TypeScript-основа без внешних вызовов (без cloud/GitHub writes/Docker):

- `src/domain` — проверка structured result и инвариантов SHA/protocol.
- `schemas/*.json` — схемы ролей scout/planner/implementer/reviewer.
- `prompts/*.txt` — шаблоны ролей из guide.
- `src/providers/fake` + `tests/` — fake fixtures и unit-тесты.

Проверка:

```bash
npm ci
npm run typecheck
npm test
```
