# Reviewer evidence: R3.1 принят, следующий Q1B

28 октября 2026. Проверенный commit `01d804ffec9848c0e4e57da993971f50488c805e`, tree `9058f9a04ed09d05102d362edbe8ad3378115df4`. Это независимые результаты review, не product remediation patch и не production qualification.

## Результат R3.1

`source-identity.json`, `input-inventory.json`, `zip-inspection.json`, `reconstruction.json` фиксируют exact master, совпадение пяти приложений, 350 ZIP members/349 internal hashes и однократное применение full patch к named base ad274. Все286 tested inputs и report совпали.

`independent-bundle/` содержит неизменные поставленные runners/fixtures и **новые независимые raw logs** в `inherited/logs/`. `validator-command.json` и `validator-exit.json` описывают один полный run: exit0,128.852s. Suite645/645,22 полные matrices,52 ledger entries; никаких diagnostic fixtures fixes, retries, splicing или tracing. Actual Linux UID0, injected application UID1000 — разные identities. Real privileged/live host qualification NOT RUN.

`independent-validation.json`, `independent-completeness.json`, `supplied-check-final-r31.stdout` подтверждают suite roster, сохранение589 прежних scenarios,56 новых R31/74 прежних R3, exact matrix IDs и source hashes. Raw expected-red historical O01/C01 oracles сохранены в том же единственном run. Динамическая среда — `inherited/logs/environment.json`. Hardcoded root NOT RUN в поставленном final checker относится к прежнему macOS run и не является измерением нового окружения.

`reviewer-initial.json` и `reviewer-final.json`: owner checkout HEAD/branch/status/index не менялись между полной начальной и итоговой фиксацией; существующий untracked сохранён; все286 source/runner inputs неизменны; production changes reviewer=0.

`review-inputs/` — исходный report/manifest/README, предыдущее ТЗ R3.1 и небольшие source validation records. Полный входной ZIP и full patch не вложены повторно: они находятся в проверенном commit, их SHA256 есть в input-inventory и аудите. `source-diff.patch` — опубликованный diff для чтения, не новый reviewer fix для наложения на master.

## Повторение полного R3.1 run

Поставленный `inherited/runners/validate-r31.py` проверяет bytes и в `--repo`, и в `--fixed`. Reviewer использовал две обычные копии: реконструкцию и опубликованный snapshot. Для read-only `git archive` исторических commits было передано `GIT_DIR` абсолютного Git object directory владельца и `GIT_OPTIONAL_LOCKS=0`; владелец не переключался. Точные argv/cwd находятся в validator-command и каждом logs/commands.json.

Повторять в отдельной fresh bundle copy с пустыми logs и новом owned work directory; не перезаписывать это evidence. Нужны Node24, npm и доступные historical Git objects. В репозитории target prefixes `audit/evidence/q1a-r3-1-2026-10-28-local/` должны содержать manifest inputs. Inspection ZIP layout не заменяет этот repository layout. Не применять full patch поверх уже исправленного master.

## Q1B baseline — отдельный следующий scope

`q1b-baseline-probes.cjs` использует настоящий NodeProcessAdapter и только конечные owned Node children. Никакого sudo/APT/Docker/network/credentials. Grandchild marker доказывает продолжение после TERM direct parent; fixture родитель дожидается и reap-ит своего child, оба завершаются сами. Итоговая проверка зафиксировала grandchild absent. Это не тест полного10s KILL и не hostile process escape.

```bash
node /absolute/evidence/q1b-baseline-probes.cjs /absolute/built-repository > /absolute/output/q1b.jsonl 2> /absolute/output/q1b.stderr
python3 /absolute/evidence/check-q1b-baseline.py /absolute/output/q1b.jsonl --mode baseline
python3 /absolute/evidence/check-q1b-baseline.py /absolute/output/q1b.jsonl --mode desired
```

Ожидаемый исход на01d804f: collector0; baseline oracle0; desired oracle1; **5 complete / 2 desired PASS / 3 FAIL**. B01 argv и B05 ambient/PATH positive; B02 output budget, B03 process-group TERM и B04 explicit preload env negative. Baseline0 означает подтверждение gaps, а не acceptance. Проверяются ordered unique IDs/META и recomputed predicates. Точные argv/exits/durations — q1b-baseline-ledger.json.

После изменения internal API разрешён отдельный минимальный mapped runner; оригинальные сценарии/raw сохранять. Нельзя превращать отказ любого normal execution в green. Эти gaps принадлежат Q1B и не переоткрывают закрытый R3.1.

## Целостность и исключения

SHA256SUMS покрывает все остальные regular-file members внутри evidence/. ZIP проверен по CRC и каждой checksum; внешний hash — в R31-checksums.sha256 рядом с аудитом. Нет symlink/absolute/traversal paths.

Не вложены node_modules, compiled product dist, __pycache__/pyc, целый repository/git/index, Library helpers, старые ZIP/full payload archives и временные deployment/child directories. Исторические JS fixtures и source patches включены как reviewer inputs. Exclusions не удаляют файлы владельца. Абсолютные пути в raw logs — provenance прежнего run, не download links.

NOT RUN: ordinary-owner/PAM production session, privileged host adapters, real Docker daemon, VM/VPS/cgroups, credentials/live/provider/model, physical power loss, full Q1B qualification и production factory. Историческая O02 cause OPEN.
