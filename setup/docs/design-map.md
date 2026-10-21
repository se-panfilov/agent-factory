# P00 design map (CONTRACT 1.0.0 foundation)

Этот документ фиксирует соответствие между требованиями `docs/automation/CONTRACT.md` и артефактами P00. Он покрывает только базовый слой схем/типов/валидации и не вводит runtime-стадии с host side effects.

| Contract section | Реализация в P00 | Комментарий |
|---|---|---|
| C02 stage ids и stage closure | `src/core/types.ts` (`STAGE_IDS`) + `schemas/config.schema.json` (`selected_stages`) | Зафиксирован статический набор `S00..S14`; plugin registry не вводится. |
| C03 error envelope и коды завершения | `src/core/types.ts` (`ExitCode`, `StageError`) + `schemas/state.schema.json` (`last_error`) | Закреплены публичные коды/поля для следующего этапа CLI/engine. |
| C04 strict config | `schemas/config.schema.json` + `src/core/validators.ts` | `additionalProperties: false`, schema/version pins, абсолютные пути, запрет paid fallback, allowlist репозиториев. |
| C05 release/versions lock | `schemas/installer-release.schema.json` | Обязательные pins для Node/npm/Docker/Codex/images/sources/qualification. |
| C06 Stage API | `src/core/types.ts` (`StageModule`, `StageOperation`, `StageReceipt`, `StagePlan`) | Контракт `observe → plan → apply → verify → recover` задан типами. |
| C07/C08 state model | `schemas/state.schema.json` | Разделены `installed/verified`, `in_flight_operation`, `pending_gates`, `drifted/interrupted`. |
| C10 retries/secrets constraints | `schemas/plan.schema.json` (`retryable`, `timeout_sec`, risk/gates) | Базовая структура плана для политики retries реализована; runtime policy — в P02/P03+. |
| C11 verification discipline | `tests/unit/contracts.test.ts` | Позитивные + негативные фикстуры (`schema_unknown`, `unknown_field`, `invalid_path`, `missing_pin`). |

## Validation scope in P00

- **Schema-level strictness**: типы, enum/const, required-поля, запрет лишних полей.
- **Semantic checks (P00 only)**: безопасные абсолютные пути без `.`/`..`; shape-check для release sha.
- **Out of scope for P00**: реальные host probes, gate approval, lock lifecycle, recovery orchestration, privileged mutations.

## Why these capability names now

`CAPABILITY_NAMES` в `src/core/types.ts` задаёт фиксированный список, используемый и в `plan.schema.json`, и в `application-manifest.schema.json`. Это не динамическая регистрация: будущие stages могут только ссылаться на заранее известные имена, сохраняя детерминированность контракта.
