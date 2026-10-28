# Q1B — локальный remediation / 2026-10-28

Результат: installer infrastructure реализована и проверена локально. Итоговый attempt3: **697/697**, исходные645 names сохранены в точном порядке,52 новых Q1B, без removed/skipped/cancelled assertions. Local acceptance B-A01…15 — PASS в описанной POSIX/injected границе; Linux/root-isolated и реальные privileged/live integration — NOT RUN. Это не production qualification и не закрытие Q2–Q6.

Никаких commit/push/branches/worktree/PR/staging/index mutations/merge/tag/release/deploy. Реальные sudo/APT/dpkg/systemd/SSH/UFW/Docker-daemon/cgroups/provider/OAuth/remote operations не выполнялись. Публикация — отдельное действие владельца.

## Identities и сохранность

Проверенный product base:01d804ffec9848c0e4e57da993971f50488c805e, tree9058f9a04ed09d05102d362edbe8ad3378115df4. Фактические initial/final HEAD:9c9dc19f5ef7795e698c8f3ebaaa637621f38f8e, tree379636ade3a05190ee310e104248c2d20deea5bc, branch master. Разница — ровно три audit-only additions: audit/Q1B-copilot-prompt.md, audit/evidence/R31-all-files.zip, audit/reviews/R31-audit.md; setup product delta отсутствовал. **Named patch base — фактический9c9dc19…**, а не подразумеваемый новый product baseline.

Index bytes/SHA256/entries/staged patch сохранены до изменений; SHA256 initial=final:
`e5503faaadfaa12ee075548da143c08eae12c558ef870112387e6ee14a8451aa`.
Шесть owner staged pyc остались с теми же bytes и staged состоянием; исходный unstaged diff пуст. Все1389 initial file hashes сверены; неожиданных изменений/удалений нет (final/preservation.json). Наблюдаемого внешнего сдвига HEAD/index не было. Initial index.bytes хранится локально, **исключён из ZIP**; пакет не содержит Git/index database.

Reviewer R31-evidence.zip безопасно распакован отдельно; реальный SHA256:
`8a041452783741a2266216a4608433e1c5abe1e408329c63a78de5a536739f92`, сверён с R31-checksums.sha256. README и исходные Q1B collector/checker сохранены. Actual host macOS15.5 arm64, Node24.22.1/npm11.17.0, actual UID501; injected application UID1000 записан отдельно. OS/root checks не ослаблялись, process.getuid не подменялся.

Идентичность final working bytes — tested-files.sha256 SHA256 **6ec5b32d406b0a721aadd2ee25afc3fb898e754118943822ef29af9be0cc6b6e**;303 sealed source/config/schema/package/test/runner/fixture inputs, включая исполняемые mapped runners и исторические contract inputs. Исторические setup trees перечислены отдельно по immutable commits в runners/historical-inputs.json. Seal metadata исключена из self-referential payload.

## Реализация

process-supervisor.ts содержит один serial transition loop: registered→running→TERM→KILL→settled. Detached POSIX spawn создаёт собственную группу; никакие PID/PGID из config/JSON не используются. First cancellation reason стабильна, lifecycle связывает run/operation/generation; late timers/listeners удаляются. TERM — группе, production grace10s; затем KILL и2s settle,250ms предел каждого group observer,25ms cadence. Cleanup требует закрытых I/O и отсутствия исполняемой собственной группы, а не child.killed/parent exit/elapsed timer. ESRCH и Linux zombie-only facts отличаются от EPERM/unknown; mismatched injected generation не авторизует signal. Реальная Linux procfs ветка здесь NOT RUN. POSIX lease и наблюдение не являются защитой от hostile OS writer/произвольного PID namespace manipulation или malicious setsid escape.

CommandResult сохраняет numeric exit|null отдельно от signal, spawn/termination reason/cleanup/output flags. Все actual production callers используют mandatory closed policy и полный commandSucceeded/commandFinished outcome; narrowing, терявшее output-limit/cleanup, устранено. Для real critical mutation — typed5 process_critical_supervisor_unavailable **до spawn**; fake critical operation не kill/retry/replay и сохраняет interrupted/in-flight8. Это явный Q2 blocker, без no-op success. Caller→policy→env→bounds→decision: setup/docs/process-lifecycle-q1b.md.

Output имеет общий byte budget stdout+stderr во время чтения, две фиксированные ёмкости без роста chunk metadata, marker внутри возвращаемого budget. Split UTF8 восстанавливается; malformed complete output имеет outputInvalid и не служит machine proof. Ограниченная known-pattern redaction проверена synthetic markers; универсальная защита от любого секрета не заявляется. Ambient env не наследуется; PATH фиксирован, shell=false. Unknown/dangerous explicit keys (NODE_OPTIONS/NODE_PATH, LD/DYLD, shell/Git/Docker overrides, TLS bypass) отказаны. Proxy/CA/fixed git-date positives проверены без сети; нет общего env passthrough.

runCliEngine устанавливает SIGINT/SIGTERM на production engine lifecycle и снимает handlers после результата. process.exit заменён на exitCode, stdout drain не обрывается. Matching durable cancel наблюдается во время активной операции (serial100ms, read bound1000ms), requests остаются read-only/retained. До admission все async cancel/context reads завершаются до прежнего конечного metadata fence; после него добавлены только synchronous lifecycle guards. Exact receipt/checkpoint prefix сохраняется перед130/143; interrupted/unknown resource или persistence/release failure дают8. Неподтверждённый process cleanup удерживает lock и process-cleanup-required.json; marker блокирует acquisition/takeover и не очищается автоматически. При неудаче публикации lock всё равно удерживается; физический power-loss исход не квалифицирован.

Emergency: один monotonic60s attempt budget, min(20s,remaining) для команды, отдельно12.75s максимум command cleanup grace и2s observation grace. Late await не разрешает новый dispatch. PAUSED not_published/published_unconfirmed/durable, confirmed prefix и unknown remainder сохраняются. Existing trusted S05 stop/status, independent Docker discovery, own/foreign/unknown, service/missing-status admission остаются прежними. Никакого реального daemon workload тестами не останавливалось.

## Attempts и фактические команды

Baseline — обычный git archive01d804ff… в /private/tmp/q1b-baseline; npm ci --ignore-scripts --no-audit --no-fund, build, original q1b-baseline-probes.cjs, baseline/desired oracle. Collector0, пять complete IDs/META,2 desired PASS/3 FAIL, baseline oracle0, desired oracle1. Raw baseline.jsonl/stderr/ledger.jsonl сохранены; collector exit не выдан за product PASS. Mapped runner меняет только обязательное internal policy wiring; исходный runner/oracle не редактировался.

Targeted process:37/37 первоначально; targeted lifecycle/R3/R31/R221:171/171. Первый новый lifecycle fixture attempt имел3 failures: ENOENT journal до intent и неправильное ожидание8 вместо contract lock7 для перекрывающего run; compile diagnostic о слишком узком FS type также сохранён в observations. Они исправлены в новых assertions, product barriers не заменялись ранним refusal.

Full attempt1:695/695,22 inherited+2 Q1B matrices,56 ledger entries, hashes298 стабильны. Дополнительный реальный controlled checkpoint fault дал cancel+rename EIO→6/очищенный in-flight. После доказанного исправления сохранения active in-flight и outcome8 targeted test1/1; before/after raw сохранены. Attempt1 целиком сохранён в attempts/attempt1, не используется как часть итогового PASS.

Full attempt2:696/696, те же matrices/56 entries, hashes299 стабильны. Дополнительные controlled probes показали незавершающийся group observer (конечный собственный child, beforeExit collector70, known injected boundary) и новый spawn при already cleanupUnknown. Исправлены bounded facts observer, pre-spawn blocker и cancellation read bound;52/52 targeted плюс отдельный signal-scope control прошли. Эта новая deliberate-red диагностика не объясняет historical O02.

**Full attempt3 — единственный итоговый полный run на final bytes**, /private/tmp/q1b-final-3:

```text
npm --prefix setup ci --ignore-scripts --no-audit --no-fund
npm --prefix setup run typecheck --silent
npm --prefix setup run test --silent
python3 .../inherited/runners/validate-q1b.py --repo <repo> --fixed /private/tmp/q1b-final-3 --bundle <evidence>/inherited --work /private/tmp/q1b-inherited-3
python3 .../runners/check-final-q1b.py <evidence> /private/tmp/q1b-final-3 <repo>
```

validate-q1b.py выполняет ci/typecheck/test и matrices в одном ledger, а не после предварительного отдельного итогового suite. Реальные argv/cwd/Node/npm/UID/stdout/stderr/exit/signal/duration для всех62 entries — inherited/logs/commands.json. Suite697/697, test139.704s; сумма измерений ledger253.266s. Final check0; все303 hashes до/после равны snapshot и checkout. Original/mapped/C13 bridge и old engine first publication для genuine v1/v2 разделены. Instrumentation0, no splicing. Ожидаемые historical oracle exit1 отдельно помечены и не считаются runtime failure.

## Матрица приёмки

| ID | Статус | Evidence / предел |
|---|---|---|
| B-A01 | PASS | original baseline5 complete/2 green/3 red; original checker0/desired1; final mapped5/5 desired |
| B-A02 | PASS | normal literal argv/CWD/shell=false/fixed path; ENOENT/EACCES absent exit/zero spawn; inherited absolute/pin controls |
| B-A03 | PASS | ready own parent+child+grandchild, real production10s TERM→KILL, held pipes, group/I/O cleanup; actual POSIX macOS. Linux native NOT RUN |
| B-A04 | PASS | first/repeated signals, pre-spawn cancel, natural error/exit/close controls, generation mismatch/EPERM, bounded pending observer, unrelated own group untouched; no hostile containment claim |
| B-A05 | PASS | shared64-byte cap incl marker, interleaved/continuous output, split/malformed UTF8, fixed-capacity retention; complete-result decisions |
| B-A06 | PASS | dangerous explicit env refusal, ambient/PATH controls, proxy/CA/fixed dates positive, split/truncated synthetic redaction |
| B-A07 | PASS | mandatory policy at actual callers; table documents sources/bounds; real critical blocker before spawn; fake critical unknown8/no replay |
| B-A08 | PASS | owned child harness through production runCliEngine: SIGINT/SIGTERM clean130/143, partial unknown8, exactly one JSON envelope |
| B-A09 | PASS | separate cancel producer, full-generation disk protocol, pre-intent0, checkpoint-identical prefix and explicit resume without replay |
| B-A10 | PASS | unknown process lock/marker blocks overlapping apply; checkpoint publication EIO keeps in-flight/8; existing cleanup/release faults retained |
| B-A11 | PASS | controlled deadline admission/before-first/between-targets/during-command, no further dispatch, PAUSED/confirmed/unknown correct |
| B-A12 | PASS | R31 14/14 +56 tests; R3 14/14 +74 tests; R221 boundary14/context5; S03/genuine v1/v2 each13; O01 honest8/fresh review/no replay |
| B-A13 | PASS |697/697, original645 exact names; frozen33/command37/R2-checker39 complete PASS; overlapping counts не суммируются |
| B-A14 | PASS |22 inherited exact-ID matrices,2 Q1B matrices,3 extra controls,62 unique ledger entries; final attempt3 отдельно от1/2; no splicing/instrumentation |
| B-A15 | PASS |303 final inputs совпали до/после; single plain-directory patch reconstruction проверена (reconstruction.json); owner/index capture и hashes сохранены |

## O01/O02 и открытые границы

R211-O01: accepted honest recover8/repeat8, fresh explicit review required; prepared metadata не авторизует effects, завершённый S03 cutover не повторяется. Original auto-success oracles по-прежнему historical known-red, raw не изменён. R211-O02 historical cause **OPEN**: новые complete runs не являются доказательством причины старого симптома. Новый deliberately injected non-settling observer имеет собственное точное before/after доказательство и не приписывается O02.

NOT RUN: Ubuntu/Linux native process-facts path, actual UID0/root-isolated container и PAM login; real sudo/APT/dpkg/SSH/UFW/systemd/Docker daemon/cgroups/VM/VPS, OAuth/provider/model/network/remote integration. Malicious escape/setsid, hostile/root filesystem isolation, hard real-time OS scheduling и physical power loss не квалифицированы. Q2 privileged executor и service/M0/M1/M2/application features не реализованы. No auto-unpause, approval/replay policy/schema/public CLI/config/pins/dependencies changes.

## Changed files и handoff

- `setup/docs/lock-cancel-r3.md`
- `setup/docs/operations.md`
- `setup/docs/privileges.md`
- `setup/docs/process-lifecycle-q1b.md`
- `setup/src/adapters/apt.ts`
- `setup/src/adapters/docker.ts`
- `setup/src/adapters/git.ts`
- `setup/src/adapters/process-lifecycle.ts`
- `setup/src/adapters/process-policy.ts`
- `setup/src/adapters/process-supervisor.ts`
- `setup/src/adapters/process.ts`
- `setup/src/adapters/systemd.ts`
- `setup/src/cli.ts`
- `setup/src/core/deadline.ts`
- `setup/src/core/engine.ts`
- `setup/src/core/lock.ts`
- `setup/src/core/types.ts`
- `setup/src/operations/backup.ts`
- `setup/src/operations/emergency.ts`
- `setup/src/operations/health.ts`
- `setup/src/operations/update.ts`
- `setup/src/stages/access.ts`
- `setup/src/stages/auth.ts`
- `setup/src/stages/configuration.ts`
- `setup/src/stages/inference.ts`
- `setup/src/stages/project.ts`
- `setup/src/stages/service.ts`
- `setup/src/stages/verification.ts`
- `setup/tests/integration/q1b-lifecycle.test.ts`
- `setup/tests/unit/process-q1b.test.ts`

Полный patch содержит owner layer (только шесть исходных staged pyc) и agent delta, включая новые source/test/docs/runners. Raw logs/seal metadata/ZIP/node_modules/dist/.git/index исключены из patch по README; raw evidence доставляется ZIP отдельно. Owner layer отдельно сохранён как initial/staged.patch; он уже включён в full-local.patch и не применяется дополнительно. new-files.tar отсутствует.

Полная реконструкция: named base9c9dc19… → один full-local.patch без index → сверка303 tested inputs и всех patch payload bytes. README задаёт переносимые локальные команды; reconstruction.json и patch-payload.sha256 фиксируют фактический результат. Пять выдаваемых файлов: этот report, full-local.patch, tested-files.sha256, evidence.zip, evidence.zip.sha256. Единственное действие владельца — передать их reviewer. Никакой публикации или privileged/live run для завершения этого локального задания не требуется.
