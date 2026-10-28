# Copilot — Q1B-R1: truthful Linux cleanup и synchronous spawn failures

Выполни только два исправления из Q1B-audit.md. Verdict Q1B: CHANGES_REQUIRED_LOCAL. Q2 не начинать; R31-F01…F04 не переоткрывать без нового evidence. Продукт reviewer не исправлял.

**Не делать коммиты, push, ветки, worktree, PR, merge, tag, release или deploy. Не менять staging/index, включая git add -N. Все изменения оставлять локально.** Этот текст переносить во все следующие промпты ИИ-агентам. Публикация владельцем не отменяет запрет для агента.

Запрещены реальные sudo/APT/dpkg/systemd/SSH/UFW/Docker daemon/cgroups, provisioning VM/VPS, credentials/OAuth/provider/model calls и внешние записи. Разрешены owned temporary FS, fake adapters, собственные безопасные children с конечным временем жизни. Не сигналить чужим процессам, не использовать killall/pkill, не удалять package-manager locks. Не выполнять reset/clean/stash/checkout ради удобства; сохранять owner staged/unstaged/untracked.

## Исходная точка

Проверенный опубликованный commit `2026fe1ebf8348fa4729e6e76bbec9404ee2ac71`, tree `f60d4bbe0e528fb9c8833da4dd2a2897d81fb4c3`; parent `a1d57546810f38352c333350539f4381b3dff86d`. Это текущая named base, если HEAD не изменился. Старый full-local.patch от9c9dc19 повторно не применять к этому commit.

Сначала зафиксируй actual HEAD/tree/branch/status/index bytes/SHA/entries, owner files. Read-only Git: GIT_OPTIONAL_LOCKS=0. При другом HEAD классифицируй product/audit delta и выбери точную named base без изменения owner history. Snapshot — обычный отдельный каталог/git archive, без worktree/index. Учитывай tar modes: Git blob bytes не доказывают безопасные filesystem permissions. Исправлять permissions допустимо только в собственном test snapshot; не chmod host paths или checkout владельца.

Прочитай AGENTS.md; docs/automation/CONTRACT.md C03/C04/C07/C09/C10/C12/C13; audit/Q1B-copilot-prompt.md; setup/docs/{lock-cancel-r3,plan-context-r22,privileges,operations,process-lifecycle-q1b}.md; новый Q1B-audit.md и raw reviewer probes. Точное исходное ТЗ сохраняет scope. Не исполнять всю P00–P15 последовательность.

## F01 — Linux group census должен быть fail-closed

В process-supervisor.ts groupFact после successful kill(-pgid,0) возвращает dead, если census /proc не нашёл members и не встретил read errors. Это не доказательство zombie-only/dead группы.

Reviewer дважды получил confirmed/exit0/null terminationReason примерно через215–225ms; обычный собственный descendant со stdio ignore после этого записал marker. Он не делал setsid, завершался сам через1100ms. В этой среде process.pid и /proc/self/stat PID различаются. Это не утверждение о нормальном Ubuntu и не запрос поддержать hostile PID namespaces.

Исправь:

- Не объявлять absent group match эквивалентом положительного zombie-only evidence. Successful kill(0) + empty/incomplete/mismatched census => unknown либо дополнительно доказанная смерть, а не unconditional dead.
- Проверить пригодность identity observation, включая согласованность пространства PID/procfs. Для неподдерживаемой среды допустим typed blocker **до spawn**. Если проблема установлена после spawn — bounded unknown, честный lifecycle outcome и сохранение защиты от overlapping effects. Не добавлять host PID translation, broad signals или cgroups.
- Сохранить normal execution, ESRCH-confirmed absence, legitimate Linux zombie-only cleanup, ready parent/child/grandchild, held pipes, child ignoring TERM→production10s→KILL, unrelated собственную группу, unknown/EPERM и generation controls. Не выдавать fallback refusal всех команд за successful supervisor.
- Добавить deterministic тесты **на реальный census decision layer**, а не только injected observer, уже возвращающий готовый status. Cases: successful kill0 + zero matches; mismatch self PID/procfs; inaccessible/partial census; положительно увиденные zombie-only members; live member. Signal targets только minted own group.
- Сохранить оригинальный reviewer runner. На среде с тем же mismatch до исправления воспроизвести false-confirmed; после — pre-spawn refusal либо честный unknown без ложного успеха. На обычном qualified POSIX/Linux окружении с согласованными facts показать прежние positive paths; недоступность явно NOT RUN. Не требовать production VPS.
- Проверить production engine последствия unknown: 8, retained lock/manual evidence, отсутствие следующего эффекта. При pre-spawn blocker не выдумывать живой процесс. Сохранить distinct resource unknown vs process cleanup confirmed.

## F02 — синхронный spawn throw должен завершать lifecycle

В текущем коде listener добавлен и generation зарегистрирована до spawn, а try/finally начинается после. Валидный для commandEnvironment аргумент200000 bytes вызывает Linux E2BIG; остаются scope.processes entry(pid:null) и direct AbortSignal listener. Снаружи raw Error без нормализованного command failure.

Охвати synchronous throws единым cleanup/settle. Нормализуй результат/typed refusal без argv/env leakage, корректно distinguish no child spawned. Удаляй listener, запись scope, timers/resources на каждом пути. Не устанавливай unknown лишь из-за доказанного pre-spawn E2BIG; не игнорируй unknown реального spawned child.

Tests: реальный finite безопасный E2BIG, если OS позволяет; deterministic synchronous spawn throw для переносимости; repeated failures; direct signal и scoped composite signal; scope map/listener baseline после failure; следующий обычный command в том же lifecycle проходит. Сохранить ENOENT/EACCES, async error/exit/close races, exactly-once settle, first cancellation reason. Не ограничиваться уменьшением max argv вместо исправления lifecycle.

## Что не менять

Full-generation locks/cancel, retained read-only request consumption, R221 final fence и отсутствие async authorization reads после него, prepared!=committed review, no replay, ordinary owner, C13/public CLI/config. Real critical operations остаются typed pre-spawn blockers доQ2; fake interrupted critical operation сохраняет reconciliation.

Emergency60s + separately bounded cleanup/observation grace не менять только ради замечания reviewer: оно снято после чтения §8 исходного ТЗ. Новые направления, приложение M0/M1/M2, live capabilities и dependency updates вне scope. Historical O02 причина неизвестна; не приписывать ей F01/F02.

## Проверки и evidence

Оригинальные reviewer raw/runners сохранить. Добавить отдельные adapted runners с mapping только там, где изменился internal API; не ослаблять смысл predicates и не переписывать старые результаты.

Сначала целевые tests, затем **один полный final run на окончательных bytes**: Node24 ci --ignore-scripts --no-audit --no-fund в собственном snapshot, typecheck, весь suite с сохранением645 baseline+52 Q1B сценариев и новых F01/F02 cases, все обязательные22 inherited matrices, Q1B/CLI/control matrices, независимые checkers. Нельзя считать collector0 доказательством PASS, складывать пересекающиеся counts или склеивать попытки. При ошибке сохранять raw и диагностировать конкретную причину; новые numbered full runs только после обоснованного изменения bytes/среды. Первый необъяснимый INCOMPLETE — сохранить и одна целевая диагностика, не retry-until-green.

Фиксировать exact IDs/order/unique counts/predicates, actual OS/arch/Node/npm/UID, injected application UID отдельно, filesystem modes, PID/procfs compatibility, before/after source+runner hashes. Не выдавать виртуализированный Linux UID0 за Ubuntu ordinary-owner/PAM qualification. Новый checker должен отражать фактическую среду и roster; не оставлять необоснованный hardcoded root NOT RUN при реально проведённых relevant checks. Native host/PAM/privileged checks отдельно NOT RUN.

Reviewer не получил полного green run: первая попытка включала его ошибку archive permissions, вторая закончилась suite exit1, её подробные temporary logs утрачены. Это не основание объявить697/697 или все inherited matrices независимо принятыми. Новую приёмку основывать на собственном полном сохранённом run; original macOS attempt3 оставить неизменным.

## Handoff

Пять файлов:

1. remediation Q1B-R1 report с F01/F02 и B-A01…15 PASS/PARTIAL/FAIL/INCOMPLETE/NOT RUN, точными командами/границами;
2. full-local.patch от фактической named base, new/deleted/binary включая owner layer отдельно объяснённый, без staging;
3. tested-files.sha256;
4. evidence.zip: original/mapped/new исполняемые runners/checkers, raw всех attempts, ledger, metadata, README и reconstruction;
5. evidence.zip.sha256.

Full patch применить один раз к чистому plain-directory snapshot, сверить inputs; не добавлять split patches поверх него. Не включать recursive старые архивы, node_modules/dist/.git/index. Следующему reviewer достаточно этих пяти файлов; commits/push/deploy/credentials владельца не требуются.

**Не делать коммиты, push, ветки, worktree, PR, merge, tag, release или deploy. Не менять staging/index, включая git add -N. Все изменения оставлять локально.**
