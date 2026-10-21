# M0.3 application release packaging

Этот каталог содержит **репродуцируемую упаковку M0.3** для существующего supervised runner из `app/m0-02-runner` и безопасную offline-проверку без OAuth/live model.

## Что входит в поставку

- исходники runner и verify-suite из доверенного commit (`runner.ts`, `verify.mjs`, `make-schemas.ts`);
- role schemas (`schemas/*.json`);
- `deployment-manifest.json` со строгими полями:
  - `source_commit`;
  - `content_hashes` (SHA-256 по содержимому файлов поставки);
  - `node_range`;
  - `capabilities` (только `runner-readonly`);
  - `commands` (`runner_run`, `runner_status`, `runner_stop`, `verify_fake`).

## Команды сборки и проверки

Сборка архива из доверенного commit:

```bash
node app/m0-03-release/scripts/build-release.mjs --source-commit <40-hex-commit>
```

Скрипт делает детерминированный `tar.gz` (фиксированные metadata/mtime/uid/gid), поэтому при том же commit hash архива повторяется.

Offline verification архива:

```bash
node app/m0-03-release/scripts/verify-offline.mjs
```

Проверка читает `app/m0-03-release/artifacts/latest-build.json`, валидирует строгую структуру манифеста, сверяет `content_hashes`, запускает `verify_fake` и `runner_status` из argv манифеста.
