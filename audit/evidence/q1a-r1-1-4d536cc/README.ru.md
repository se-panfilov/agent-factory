# Q1A-R1.1 evidence pack (4d536cc baseline)

Артефакты для воспроизведения ключевых probes N00/N01/N02/N03/N06/N07 и подтверждения итогов remediation R1.1.

## Содержимое

- `probe-r11-matrix.cjs` — probe runner (`baseline`/`fixed` mode).
- `baseline-setup-build.log` — сборка setup в чистом worktree на `4d536cc`.
- `results-baseline-4d536cc.json` — результаты probes на baseline.
- `results-fixed-c123cd3.json` — результаты probes на исправленном коммите `c123cd3b8793dcf96ab24836feb4acfe2f3f3bf9`.
- `node24-ci-typecheck-test.log` — прогон обязательных команд Node 24 (`ci/typecheck/test`) на исправленном коде.
- `commands.txt` — точные команды, которыми получены логи и результаты.

## Шаги воспроизведения

### A. Baseline (ожидается failing behavior)

1. checkout baseline `4d536cc4917e3f6f468fe41a62e2cfb31718361c`;
2. Node 24 (в отчёте использован `v24.12.0`);
3. выполнить:

```bash
PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" npm --prefix setup ci --ignore-scripts --no-audit --no-fund
PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" npm --prefix setup run build --silent
PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" node audit/evidence/q1a-r1-1-4d536cc/probe-r11-matrix.cjs baseline
```

### B. Fixed branch (ожидается passing-after для N00/N01/N02/N03/N06/N07)

1. checkout fixed branch/commit (`fix/q1a-r1-journal-recovery`, `c123cd3...`);
2. Node 24;
3. выполнить:

```bash
PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" npm --prefix setup ci --ignore-scripts --no-audit --no-fund
PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" npm --prefix setup run typecheck --silent
PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" npm --prefix setup run test --silent
PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" node audit/evidence/q1a-r1-1-4d536cc/probe-r11-matrix.cjs fixed
```

## Ограничения

- Только temp FS и fake/injected adapters.
- Реальные sudo/apt/systemd/SSH/firewall/Docker daemon/OAuth/model/provider/GitHub writes: **NOT RUN**.
