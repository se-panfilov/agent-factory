# Q1A-R1.5 — локальные исправления S03/S04/S05

Дата: 2026-10-25 (Europe/Amsterdam). Code status: **PASS в ограниченном R1.5 scope**. Local validation: **PASS**. Real-host qualification: **NOT RUN**. Q1A/AF-05/AF-06/production не закрыты. Коммит, push, ветка, PR, merge, release или deploy агентом не создавались.

## Identity и сохранённое исходное состояние

Фактический base HEAD: `d7d141106aa50f58c8ec9ac7c3991b4d9b42e6e6`, tree `dad67852d36e14014177237719870acc5a8609dc`, branch `master`. Начальный `git status --porcelain=v1` пуст; staged/unstaged/untracked чужих изменений нет, input layer пуст. Начальный SHA-256 index: `c5f17513b41fd70c80cb2f8339ef687e45f6f5efc6d97c68f69d7662fbd5a10d`; итоговое сравнение находится в `final-repository-state.json` архива. Index не использован для подготовки patch.

От проверенного `2eb026527d3448fc0d455f6fe8713cba61c0d3c5` фактический HEAD отличается только четырьмя уже закоммиченными входами: `audit/copilot-r15-task.ru.md`, `audit/evidence/agent-factory-r14-review-evidence-2eb0265.zip`, его `.sha256`, `audit/reviews/agent-factory-r14-audit-2eb0265.ru.md`. Их точные имена и SHA-256 сохранены в `base-delta.json`. Production setup идентичен проверенной базе; все три замечания применимы. История не переписана.

**Нового tested commit нет:** проверялось локальное дерево. Его identity — base + `full-local.patch`, включающий добавления, и manifest `tested-files.sha256` (135 файлов; SHA-256 `2d70f17d321a92acdabe9baa832e30adeab63b3ec9b6fc93b4481d06e8941f01`). Manifest покрывает весь tracked setup и новые setup source/tests/helpers/docs/config/lock/schema/fixtures/bootstrap/release файлы. Deletions: пустой список. Исключены dependencies, dist, Git metadata, audit/report/packaging metadata и временные результаты; credentials не собирались. Report добавлен после проверки кода и не входит в tested manifest. Self-referencing hash не используется.

## Изменения production и границы

**R14-F01 → V01–V03.** В `setup/src/stages/application.ts` общий порядок: reviewed archive/config/profile checks → соответствующий journal/config-bound materialization receipt → допустимые команды → текущие bytes/ownership/type → bounded offline probes. Он применяется к observe, verify и отдельной probe operation; повторные apply/resume проходят ту же admission. В `adapters/git.ts` проверяется deployment root и каждый компонент content path, запрещаются symlink/special/unsafe write permissions и неконечные пути. Entry исполняемой команды должен быть включён в `content_hashes`; произвольный external executable, sudo, Node eval/unbound entry не авторизуются. Реальный adapter повторяет hashes перед каждой командой. Это не доказательство устранения всех OS-level TOCTOU между hash-read и exec.

Integrity failure: exit 9 `s05_deployed_integrity_failed`, до probe adapter; required command missing: exit 5; false probe: exit 5 `s05_runner_probe_failed`; неожиданный operational probe exception: exit 6 `s05_runner_probe_error`. Ни receipt, ни verify/checkpoint проваленного probe не публикуются; downstream не исполняется. Plain status не запускает процессы и не меняет evidence. При plan/status-refresh отказ не переписывает ранее записанное verified: это историческое состояние, команда возвращает integrity error; explicit verify инвалидирует stage.

Новые receipts дополнительно содержат canonical manifest digest внутри существующего `versions`. Совместимость R1.4: receipt без этого digest допускается только при прежнем core journal/config binding, совпадающих directory/archive SHA/commit, повторной проверке manifest архива и текущего content. Source commit marker сам по себе не даёт права запуска. Public CLI/config/state schemas и enum exit codes не изменены.

**R14-F02 → V04–V07.** В `stages/docker.ts` порядок теперь install → account group → durable pause при неактивной process group → config merge → validate/restart → resource probe → managed marker. Service/API postconditions сохранены. До session-dependent operations admission проверяет свежую owner session, API и workload safety. Подтверждённый group update получает receipt и complete checkpoint до exit 4 `operation_manual_pause`; in-flight очищается штатным core protocol. Старый процесс повторно получает exit 4 до нового intent. После login нужен свежий remaining plan и approvals его config/restart gates. Известные install/group не повторяются. Неизвестный effect остаётся blocker.

В `adapters/docker.ts` отдельны daemon access, account/process groups и workload inspection. Неуспешные/невалидные info/version/ps не становятся безопасным пустым daemon: unknown counts отрицательные, inspection не verified. Данные socket/TCP также имеют явную неопределённость. Только proven own package/group preparation допускает отложенную owner API inspection; config/restart её требуют. Активная session с недоступным API — ошибка, а не предложение подтвердить relogin. Unmanaged/foreign/public/TCP/world-write/unsafe socket guards сохранены. Ни sudo Docker, ни root installer, ни newgrp, ни chmod 666 не добавлены.

**R14-F03 → V08–V10.** В `stages/access.ts` выбрана разрешённая policy B: нет Include либо один global case-insensitive `Include /etc/ssh/sshd_config.d/*.conf` в основном файле до Match. Допустимы один canonical path с одинарными/двойными quotes, whitespace и whitespace-separated comments. Все принятые drop-ins разбираются, включая Match bodies. Proof включает sorted glob membership, bytes, uid/gid/mode и безопасные parent directories. External/relative/other glob/multiple paths, дополнительные/nested/conditional Include, escapes/equals/malformed quotes — typed exit 5 `s03_include_unsupported`. Неизвестная Include не игнорируется. Cycle/depth отклоняются на первом nested edge; рекурсивного resolver нет.

Bounds: 256 KiB/file, 2 MiB aggregate, 64 entries в единственном include directory. Referenced directory unreadable/missing, EACCES, symlink/special/unsafe owner и invalid text encoding блокируются до effects, без исправления permissions. Empty standard glob допустим и его изменение видно в proof. R1.4 raw drift и predecessor receipt guard сохранены. Универсальный OpenSSH resolver не реализован; поддержанные и запрещённые layout описаны в `setup/docs/access-recovery.md`.

Менялись только 5 production файлов, соответствующие tests/helpers, четыре setup docs и этот report. Core engine/state, contract/schema, application/M0 не менялись. Inventory S00…S14 уточнён только для фактических S04/S05 изменений; generic S08/S14 containment сохранён.

## Baseline → fixed на одинаковых frozen fixtures

Входной ZIP распакован вне source tree. Сохранён исходный `r14-new-probes.cjs`; один и тот же frozen fixture набор запускался на base и реконструированном fixed tree. `harness_ok`/exit 0 не считались product PASS.

| Measurement | Baseline d7d1411 (production = 2eb0265) | Fixed |
|---|---|---|
| N01 plan | после обнаруженного mismatch +1 probe, exit 0 | +0 probe, exit 9 integrity |
| N01 verify | +1 probe, exit 5 runner failure | +0 probe, exit 9 integrity |
| N01 status-refresh | +1 probe, exit 8 | +0 probe, exit 9 integrity |
| N02 clean no process group | install=1, restart=1, group=0, exit 8/in-flight restart | install=1, group=1, restart=0, probe=0, exit 4, awaiting_manual, in-flight=null; group intent/effect/verify/checkpoint |
| N02a actual adapter denied socket | daemon/API false, safe negative control | daemon/API false, inspection unknown rather than empty |
| N03 external Include | принято, content/ownership proof не меняется | explicit `s03_include_unsupported` |

Для исходного N03 FS fixture не моделировал `/etc` и `/etc/ssh`. Исходный runner на fixed безопасно отказывает уже при lstat этих родителей. Сохранён отдельно `r14-new-probes-directory-contract.cjs`: единственная адаптация добавляет безопасные directory metadata для этих двух путей. Baseline с адаптацией по-прежнему принимает внешний Include и игнорирует изменение; fixed возвращает именно Include refusal. Остальные сценарии/fixtures не изменялись. Итог обоих fixed runners: 6/6 ожидаемых безопасных измерений; baseline 1/6.

Для C07 старый comparison runner адаптирован отдельно: после нового login запрашивает и одобряет remaining reviewed plan перед resume. Это необходимо, потому что config/restart теперь находятся после pause; gate binding не обходится. Исходный runner сохранён. Адаптированный runner одинаков на baseline/fixed, frozen fixtures неизменны. Дополнительные realistic SessionDockerAdapter tests не подменяются этим историческим fake.

Пять первоначальных regression tests добавлены до production edits: 3 tamper commands, clean Docker pause, external Include. На неизменённом base + только test/helper layer сборка exit 0, tests exit 1: **0 pass / 5 fail** по требуемым безопасным assertions. `red-layer/`, `red-commands.json`, `red-tests.log` сохранены. Отдельный первичный MODULE_NOT_FOUND был harness error при копировании dependency symlinks; сохранён и исправлен только в temporary copy. Он не засчитан как product failure. Более поздние расширенные tests не объявляются выполненными до fix.

## Acceptance и конкретные assertions

Все V PASS относятся только к разрешённой local scope. Полные развёрнутые имена passing assertions и log locations находятся в `acceptance-matrix.json`, а не выводятся из одного количества tests.

| ID | Finding; code | Assertions / evidence | Local status |
|---|---|---|---|
| V01 | F01; application + git | `V01 actual application adapter …: zero executable invocations`: 6 integrity faults × plan/verify/status-refresh/apply/resume на отдельных fixtures; реальные production hash/probe методы, ProcessAdapter trap=0, counter не вырос, exit9; plain status bytes неизменны. N01 counters в independent logs | PASS |
| V02 | F01 | `V02 materialization checkpoint to probe drift …`: настоящая materialize binding boundary, изменение bytes, zero commands/downstream, нет probe verify/checkpoint/new verified | PASS |
| V03 | F01 | `V03 actual clean release …`, receipt/config/release/path mismatch и actual unbound/sudo entry tests; U02 success/negative/timeout/missing и no-trust tests: valid probes реально вызваны, repeat verify успешен; missing command до invocation, false/timeout блокируют | PASS |
| V04 | F02; Docker adapter | `V04 actual NodeDockerAdapter …`: intercepted argv, account ≠ process membership, socket0660; permission/down/malformed info/version/ps/ps failure/healthy controls; никакого реального Docker | PASS |
| V05 | F02; Docker stage | `V05 clean Docker …`: packages/group/member отсутствуют, API denied после install; group checkpoint, exit4/manual/null in-flight; config/restart=0 | PASS |
| V06 | F02 | `V06 realistic clean Docker old/new sessions …` и account-old-session/already-active: новый engine, old session без нового intent/effects; new session fresh approvals, verify/repeat, install/group по одному | PASS |
| V07 | F02 | `V07 Docker …`: foreign/unmanaged/public/TCP/socket/unknown/malformed refusals, pin/config/account drift, реальные отрицательные restart/API/probe postconditions. 5 fault boundaries × on/control, exact path/hit и hashes; 3 IPC child barriers effect/bound/pause + SIGKILL/restart/reader/foreign lock. Unknown group не replay; bound group сохраняется | PASS |
| V08 | F03; raw collector | `V08 …`: external/nested/conditional/lowercase/quotes/multiple/relative/glob unsupported syntax либо explicit supported canonical result; ни один external graph не принят как полный proof | PASS (policy B) |
| V09 | F03 | `V09 …`: standard layout positive, glob add/remove/content/mode, count/bytes/aggregate, unreadable/missing race/symlink dirs+files+parents/owner/special/encoding, deep cyclic nested refused сразу; bounded reads и zero mutation | PASS (policy B) |
| V10 | F03 + сохранённый R1.4 guard | `V10 actual collector to Access stage to engine …`: content/owner/nested drift до первого intent; effective dump неизменен, zero access effects. Clean control разрешает штатные own transitions | PASS |
| V11 | сохранение R1.4 | полная suite 364/364; C01…C12 assertions; U01…U10, U04/U08 S02 child barriers, U05 uniform admission, U07 manifest faults, K10/старые guards внутри suite; real S00…S07 closure, S06 no-op | PASS local regression |
| V12 | packaging | reconstruction и post-validation manifest совпали, index/HEAD сохранены, полный patch с additions, independent runner logs/fixtures, identity/checksums; без нового commit | PASS local |

Новые fault measurements: `r15-docker-fault.json` — 10 rows (5 boundaries, каждый отдельный control); `r15-docker-crash.json` — 3 actual child rows. Сохранённые R1.4 measurements из окончательного прогона: 36 manifest fault rows (initial/operation/final × write/fsync/rename/dir-fsync × before/after/control), 10 S02/recovery child rows и 4 recovery-write fault rows. Physical power loss NOT RUN.

C01 direct и plan-first recovery успешны и идемпотентны, last checkpoint остаётся; C02/C03/C04/C09/C12 блокируют противоречия до изменения evidence; C05 сохраняет refresh/simulate до unknown install; C06 failed probeCalls=1 без ложного proof; C08 rollback=1/disarm=0; C10 applyCalls=0; C11 cutoverCalls=0. Machine assertions проверены отдельно `check-results.py`; synthetic C12 так и назван, не заменяет engine-generated C01.

Исторический смысл IDs не менялся: R11-F01 generation; F02 recovery/immutable decision; F03 receipt/journal; F04 no-op/S06; F05 typed persistence; F06 evidence. R12-F01 producer/engine; F02 uniform recovery; F03 plan-written marker; F04 durable progress; F05 evidence/mapping. R13-F01 S03 drift; F02 final proof recovery; F03 S05 probes; F04 all-evidence admission; F05 group cycle; F06 tests/inventory/claims. K/T/U не переименованы в V и не получают новых ретроспективных PASS. Сохранён исторический `acceptance-mapping.json` R1.4 как input, его tested commit не является identity R1.5. Этот проход не повторяет прежние необоснованные T07/T08 claims и не расширяет пределы T03/T10 до реального host qualification.

## Фактическая validation

Host: macOS 15.5 arm64; target Ubuntu qualification этим не подменяется. Реальный Node **v24.12.0**, npm **11.6.2**. `process.versions` не подменялся. Исходные workspace dependencies не удалялись; `npm ci` выполнен в baseline и reconstructed temporary copies.

| Command (в reconstructed copy после окончательных code edits) | Exit | Result/log |
|---|---|---|
| `node --version` | 0 | v24.12.0; reconstructed-node-version.log |
| `npm --version` | 0 | 11.6.2; reconstructed-npm-version.log |
| `npm --prefix setup ci --ignore-scripts --no-audit --no-fund` | 0 | reconstructed-ci.log |
| `npm --prefix setup run typecheck --silent` | 0 | reconstructed-typecheck.log |
| `npm --prefix setup run test --silent` | 0 | **364 passed, 0 failed, 0 skipped**, reconstructed-tests.log |

Base suite: 254/254. Final workspace suite: 364/364. Отдельный reconstructed full run: 364/364. Все independent runner commands на base/fixed завершились 0 как harness; продуктовые assertions проверены отдельно. Полные argv/cwd/exit/elapsed — `validation-commands.json` и `independent-final/independent-commands.json`. Промежуточные red/failed runs сохранены с обозначением; они не входят в final PASS. После окончательной validation source/tests/config/lock/schema не редактировались.

## Артефакты и воспроизведение

Локальная папка: `audit/evidence/q1a-r1-5-2026-10-25-local/`. Содержит этот report, `full-local.patch`, `new-files.tar` + `new-files.json`, `identity.json`, `tested-files.sha256`, `deletions.json`, `evidence.zip` и `evidence.zip.sha256`. Patch уже содержит new files: tar — альтернативный явный payload, применять его повторно поверх patch не требуется. Report в папке и canonical report совпадают по bytes.

В обычную пустую временную папку распаковать `git archive d7d141106aa50f58c8ec9ac7c3991b4d9b42e6e6`, применить `git apply full-local.patch` (без index), затем проверить manifest и отсутствие deletions; README и reconstruction script приложены. Manifest восстановленной копии реально сравнен до/после npm validation. Report/identity/evidence — отдельный packaging слой вне tested-code hash. ZIP содержит runners, frozen fixture inputs, red test layer, команды, полные logs, counters, acceptance matrix и SHA256SUMS; доступ к личной Copilot session directory или дополнительному архиву не нужен.

## Открытые границы и human review

S03 `NodeAccessAdapter.applyCutover` пуст, timer/staging/rollback используют manual markers: **Q2 code blocker OPEN**, не только NOT RUN. Привилегированный executor/ownership/security qualification и фактические sudo/apt/systemd/SSH/UFW/Docker paths — **NOT RUN / отдельный Q2 scope**. VM/VPS, live/OAuth/provider/model/GitHub writes, release/merge/deploy, physical power loss — **NOT RUN**. Универсальный SSH Include graph — **не поддержан**, безопасный refusal задокументирован; полное OS-level TOCTOU устранение — **OPEN вне этого результата**.

R1.5 local scope готов к human code/evidence review; общая installer/production qualification остаётся открытой. Следующему аудитору передать report, patch/new-file payload, identity/manifest и ZIP/checksum: изменений на GitHub нет, ссылка только на master исправления не содержит. Следующий пакет агентом не начинался.
