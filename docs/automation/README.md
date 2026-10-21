# AI Software Factory — Phase 1

Полный дизайн полуавтоматического deployment, без установки и production installer scripts.

1. [Аудит](automation-analysis.md): инвентаризация всего guide и исправления.
2. [План этапов](automation-plan.md):15 stages, MVP/advanced и graph.
3. [Архитектура](automation-architecture.md):bootstrap, error matrix, state/recovery, тесты.
4. [CONTRACT1.0.0](CONTRACT.md):единый обязательный интерфейс всех prompts.
5. [Порядок Copilot](copilot-execution-plan.md):16 последовательных implementation PR.
6. [Первый prompt](copilot-prompts/00-contract-and-foundation.md).
7. [Будущая установка](deployment-walkthrough.md):planned CLI и manual gates.
8. [Реальные blockers](open-questions.md).
9. [Guide4.1](agent-factory-guide.ru.md):точечные уточнения F01–F15, исходная архитектура сохранена.
10. [Исходная4](agent-factory-guide.ru.original-r4.md):неизменённая копия для сравнения.
11. [Самопроверка](phase1-validation.md).

Скопировать комплект в `docs/automation/` приватного repo. Начать P00, затем строго последовательно. Для реального первого runner нужен отдельно reviewed application package M0; для unattended — product PRs, а не ещё один setup flag. MVP — S00–S07 offline, отдельно S08 live. Всё после первого toy run можно вводить постепенно.
