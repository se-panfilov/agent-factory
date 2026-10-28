# Evidence: независимый review Q1A-R3 → R3.1

Дата: 2026-10-27. Проверенный продукт: `e217f397b952942b62e847788dc2e6698ad6d7e5`, tree `41fe20304e340133bd7e217aceea674c466015e3`.

Итог: PARTIAL. Это пакет наблюдений и воспроизведений, не исправление продукта и не production qualification. Основной вывод и ТЗ находятся рядом с ZIP: `R3-audit.md`, `R31-copilot-prompt.md`.

## Как читать пакет

1. `source-identity.json`, `input-inventory.json`, `reconstruction.json` — исходные bytes, совпадение пяти приложений с master, проверка ZIP и применение полного патча один раз к named base.
2. `review-inputs/` — поставленный Copilot report, исходный manifest270 и предыдущее ТЗ R3. Полный входной ZIP/patch повторно не вложен: их SHA256 и расположение указаны в аудите; они находятся в проверенном commit.
3. `reviewer-initial.json`, `reviewer-final.json` — сохранность исходной рабочей копии владельца, итоговые source hashes и классификация. Product source reviewer не менял.
4. `independent-bundle/` — исходный validator на точном master. Typecheck PASS, setup suite574/589;15 failures. Raw test stdout/stderr находятся в `inherited/logs/`. Command: `validator-command.json`; exit1: `validator-exit.json`.
5. `diagnostic-bundle/` — отдельная копия с тремя изменениями только test calls. Suite589/589, boundary14/context5; затем S03 INCOMPLETE из-за omitted ProcessAdapter во внешнем runner. `diagnostic-fixtures-only.patch` и `diagnostic-identity.json` фиксируют ровно эти изменения. Command/exit1: `diagnostic-validator-command.json`.
6. `remaining-bundle/` — отдельное выполнение оставшихся17 матриц на неизменных production/source bytes master: S03/genuine v1/genuine v2 по13, O01 honest recovery, frozen/command/R2. Driver и34 command-ledger entries не являются полным повторным all-in-one run. `remaining-command.json` содержит exit0. Identity adaptation сохранена отдельно в `portable-runners/`, `runner-identity-mapping.patch` и `.json`.
7. `r3-original-adapted.*` — исходный R3 runner на actual UID0: exit1/incomplete. `r3-explicit-identity.*` и `r3-explicit-check.*` — тот же контракт с явной fixture identity:14/14. Completeness controls:8/8. Отдельный ledger — `r3-portable-ledger.json`. Все74 новых suite tests перечислены в `r3-new-tests-complete.json`.
8. `r31-boundary-probes.cjs`, `check-r31-boundaries.py`, `r31-boundary.jsonl` и связанные files — новые14 независимых probes. Collector0 означает только завершение; desired oracle1 означает7 подтверждённых gaps, baseline oracle0 означает совпадение с установленным дефектным поведением. Проверяются точные IDs, порядок, uniqueness, META, достигнутые hooks, counters и outcomes.

**Раздельные прогоны не склеены в один полный PASS.** Original failures и known-red historical oracles сохранены. Сопоставления frozen33/command37/R2-checker39 пересекаются; их нельзя складывать как независимые tests.

## Воспроизведение новых14 probes

Использовать отдельный обычный directory snapshot проверенного commit, не переключать owner checkout и не создавать worktree. Нужны Node24 и установленные setup dependencies; collector использует скомпилированный настоящий SetupEngine и штатную trusted emergency fixture. Сначала собрать setup обычной командой проекта. Выполнение внешних privileged adapters заменено fake adapters. Collector не запускает реальные sudo/APT/Docker/SSH.

Пример после сборки, с заменой абсолютных путей:

```bash
npm --prefix /absolute/exact-source/setup ci --ignore-scripts --no-audit --no-fund
npm --prefix /absolute/exact-source/setup run build --silent
node /absolute/evidence/r31-boundary-probes.cjs /absolute/exact-source > /absolute/output/r31.jsonl 2> /absolute/output/r31.stderr
python3 /absolute/evidence/check-r31-boundaries.py --mode baseline /absolute/output/r31.jsonl
python3 /absolute/evidence/check-r31-boundaries.py --mode desired /absolute/output/r31.jsonl
```

На исходных bytes ожидается: collector0, baseline0, desired1,14 complete/7 desired PASS/7 FAIL. После исправлений baseline-expected-defect oracle закономерно станет red; desired должен стать green. Исходные результаты не переписывать.

R3 standalone adapted runner и legacy matrices требуют соответствующих inherited fixtures, genuine historical commits и documented FS API bridge. Их точные argv и cwd сохранены в JSON ledgers. Абсолютные старые scratch paths — provenance прогона; для повторения в другой среде заменить directory roots, не менять product predicates. Исходный baseline driver остановился на suite failures; диагностический — на S03. Continuation driver сознательно пропускает уже отдельно сохранённые шаги и не выдаётся за полный driver.

## Среда и границы

Reviewer: Linux x86_64, Node24.22.1, npm11.9.0, actual UID0; injected application identity1000/factory. Эти две identity различны и записаны отдельно. Запрет production root execution не ослаблялся. Попытка запуска отдельного child с UID65534 отклонена контейнером EPERM до запуска; ordinary-owner host session NOT RUN.

NOT RUN: реальные sudo/APT/systemd/SSH/UFW/Docker daemon, credentials/OAuth/model/provider calls, VPS/VM provisioning, full process-tree qualification, physical crash и production factory. Emergency/container probes используют fake live facts и не доказывают incident на реальном daemon.

`source-diff.patch` — материал review опубликованной разницы, не инструкция накладывать исправления на master. `diagnostic-fixtures-only.patch` и `runner-identity-mapping.patch` — прозрачные диагностические адаптации. Production remediation в этом пакете отсутствует.

## Целостность и исключения

`SHA256SUMS` проверяет все остальные regular files внутри `evidence/` и исключает только сам себя. ZIP содержит только относительные regular-file paths; после создания проверены CRC, безопасные пути и каждый внутренний SHA256. Внешний hash ZIP находится в `R3-checksums.sha256`.

Не включены `__pycache__`, `.pyc`, node_modules, compiled product dist, целые source snapshots, git directories/index, рабочие временные deployment trees, Library helpers, предыдущие ZIP или повторный полный входной patch. Source fixture `.js` из исторических harness включены намеренно: это исполняемые входы проверок. Никакие exclusions не удаляют исходные owner files. Сохранённые raw logs могут содержать абсолютные temp paths; это не текущие download links.
