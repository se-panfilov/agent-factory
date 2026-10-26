# Frozen runner adapters (originals unchanged)

`original-runners.json` verifies all28 originals byte-for-byte against supplied/prior evidence. No original oracle is edited. Baseline roles: f12791c/setup-identical117a71e context, ca6d0b6 unsafe R2, b888082 unsafe command, 6281df5 genuine S03v1. R2.1.1 base also supplies genuine v2 publications.

| Adapter | Necessary translation | Functional assertions preserved |
|---|---|---|
| context-binding-c13.cjs | Enumerate gates in flat stage_scope/operations; fixture now supplies explicit OS/session and actual valid owned lock | B01–B05 actual engine/S02 counts and desired oracle unchanged |
| c13-fixture-compat.cjs / build-c13-adapters.py | Local parse/encode/canonical/schema callsites convert old test view to/from native wire; trusted synthetic fixture producers explicitly declare fixture.counter; no production monkeypatch | Recomputed self-hash tampering, gates/TTL/errors/counters remain original; production schema/engine/producers execute |
| inputs-c13 | Separate frozen-helper layer adds fake OS/audit-session identity, real valid temp lock and owned dummy artifact/SHA where release applies | No real privileged/network effects; old fake stages remain fake. Originals in inputs untouched |
| C01 within named C13 comparison | C13 review has prepared+committed state writes; previous is prepared metadata snapshot, not pre-review byte hash | Still genuine engine apply→plan→primary loss; exact checkpoint/completed receipt/progress arrays preserved, clean verified/no in-flight, direct/plan-first recover/retry0; no synthetic matching checkpoint |
| s06-noop fixture | Prepare actual owned archive+SHA before direct S06 setup | Same no-op gates/writes/apply assertions; no admission bypass |
| legacy-to-c13-explicit-review.cjs | Initial engine is genuine old code. Both legacy continuation branches explicitly create/review C13 plan, enumerate new-format gates; inject current identity matching unchanged historical fixture host and actual valid lock | Same13 rows, cancel130, same ordered effect counts1 each and no replay, same original product oracle. Legacy approval never executes as C13. Historical macOS-generated config architecture is retained, not silently rewritten |
| trace-owned-fs.cjs | Diagnostic preload records begin/done/error for owned async FS calls with PID/cwd/hrtime; no FS return/content changes | Same C13 comparison runner/oracles/counters. Timing is affected; traced green is NOT a fix/proof of runner stability |

Original S03 continuation and command-identity probes execute unchanged against fixed code. Original supplementary final-recovery desired runner remains known-red; its unchanged measurement runner proves explicit-review workaround. Direct adapter/stage command fixtures remain synthetic archive/receipt tests, not full engine/archive qualification. Full lifecycle uses actual producers with fake external adapters.

The first combined reconstructed comparison produced only a deadline message. It is preserved as harness failure; no product PASS inferred. Complete traced matrices and their shape/expected counts are checked separately. R211-O02 stability/cause OPEN. No commits/push/branches/worktrees/index/PR/merge/tag/release/deploy or host effects are authorized by adapters or generated follow-up prompts.
