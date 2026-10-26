# Reviewer evidence — R2.2 / ad84212

This directory is evidence from an independent local review, not product changes.
The parent audit is `R22-audit.md`; the next task is `R221-copilot-prompt.md`.

## Identity and scopes

- `source-identity.json`, `input-verification.json`, `reconstruction.json`: exact source/attachment/reconstruction identity.
- `reviewer-initial.json`, `reviewer-final.json`, `reviewer-hashes-after.json`: owner checkout unchanged; all157 setup inputs and609 tracked snapshot files unchanged.
- `inputs/`: copies of current Copilot attachments and previous audit/task. `copilot-evidence.zip` is the unmodified original input, hash recorded in source-identity. Its supplied checksum file retains the original basename; compare the digest to the renamed copy explicitly.
- `source-diff.patch`: reviewed setup delta, not a reviewer-generated product fix.

## Independent replay

`independent-bundle/` contains copies of the provided original/frozen runners and explicit C13 fixture adapters. Its `logs/` were generated independently here. No input logs were copied into that output directory.

Run recorded in `validation-driver.log` and `independent-bundle/logs/commands.json`:

```text
python3 <bundle>/runners/validate-r22.py --repo <git-repo-with-history> --fixed <ad84212-archive-directory> --bundle <fresh-bundle-directory> --work <new-empty-work-directory>
```

Use a fresh bundle output and work directory, retain runner/inputs/inputs-c13/tested-files/identity. The current result is INCOMPLETE/exit1, not a full green run. `independent-replay-completeness.json` records missing rows. The157-file after-hash verification was performed separately after the validator stopped; it is not a claim that its unreachable final checker ran.

## New boundary counterexamples

Use Node24 and a built exact source snapshot. Both runners restrict external effects to fake adapters. They use owned temporary files and never execute sudo/APT/Docker/network commands.

```bash
node context-boundary-probes.cjs /absolute/path/to/built-repo > context-boundary-probes.jsonl 2> context-boundary-probes.stderr
node release-boundary-probes.cjs /absolute/path/to/built-repo > release-boundary-probes.jsonl 2> release-boundary-probes.stderr
python3 check-boundary-results.py /absolute/path/to/output-directory --expect fixed
```

Run into a fresh output directory; preserve current evidence. The checker expects the exact two output basenames. On ad84212 the desired checker must exit1:14 complete cases,6 positive controls pass,8 negative cases violate the desired refusal. `--expect observed-current` exits0 only when that exact old behavior is measured. It is not product acceptance. See `reviewer-oracle-commands.json` for actual checker invocations/exits.

The final S02 hook distinguishes `policyObservation` from `admitOperation` inside policy admission. The S05 hook records the production stack for the fifth hash call, the final context capture before first effect. These numbers/names are fixture targeting details; after a refactor a transparent adapter may be needed. Never count an untriggered barrier as a safety PASS.

`*-attempt1.*` / `context-*-attempt2.*` are preserved exploratory fixture attempts. They are not final results. See the audit for their classification. Final files have no `attempt` suffix.

## Reproduction limits

Actual reviewer Linux x86_64 / Node24.22.1 / npm11.9.0 / UID0; injected Ubuntu24.04 amd64 ordinary owner1000. Full real privilege, OS-session and disposable-VM qualification NOT RUN. Source checks are local; no claim of production readiness or live exploit is made.

The evidence archive has an internal SHA256SUMS covering every member except itself. The outer R22-checksums.sha256 covers the delivered audit, prompt and evidence ZIP. Product source is unchanged.
