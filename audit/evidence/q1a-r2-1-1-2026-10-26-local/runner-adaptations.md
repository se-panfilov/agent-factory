# Runner identity and adaptation

`access-continuation-probes.cjs` and `check-access-continuation.py` are byte-identical to the reviewer ZIP. Original oracle unchanged, expected cancel exit130. Baseline desired oracle is deliberately exit1 / 10 product failures, not a harness failure.

`access-legacy-transition.cjs` changes only module selection: first plan/approval/apply-cancel uses the actual baseline engine and AccessStage; continuation and explicit re-plan use fixed engine/AccessStage. Fake observation/counters/cancel and all 13 expected counts are unchanged. This independently checks genuine old v1 publications, separately from synthetic metadata corruption/downgrade unit fixtures.

Frozen R2/command/comparison runners and fixtures are unchanged from the earlier R2.1 evidence. Their previously documented directory-contract and fresh-gate adaptations are preserved under their original filenames. R2 baseline is ca6d0b6; historical unsafe command baseline is b888082; current S03 baseline is 6281df5 (setup-identical to d8728f5). These are three different roles. The 33,37,39 assertion counts overlap and must not be summed.

No commits/push/branches/worktree/index/PR/release/deploy are permitted in reproductions or generated follow-up prompts. All external privileged effects are fake adapters.
