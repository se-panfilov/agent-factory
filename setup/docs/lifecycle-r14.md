# R1.4 internal lifecycle protocol (contract 1.0.0 unchanged)

Engine invokes apply with exactly one operation. A stage must confirm that operation's postconditions before returning its receipt. A receipt for materialization never proves a command probe. Core alone writes journal/state/commit metadata. `previousOperationReceipt` is supplied only after durable operation checkpoint binding; it is not permission to skip observation.

## Transaction and crash boundaries

| Boundary | Durable evidence / restart rule |
|---|---|
| Admission, before in-flight | Full evidence admission and fresh gates/inputs; no effects |
| In-flight persisted, before intent | Unknown, block replay |
| Intent durable, before effect | Unknown, block replay |
| Effect returned, before receipt durable | Unknown, block replay |
| Effect evidence durable | Operation evidence exists, stage not verified |
| Operation postconditions confirmed | Verify record describes producer-confirmed postconditions |
| Checkpoint appended, before manifest binding | Binding mismatch, block; no automatic replay |
| Operation checkpoint bound | Known operation progress, still no stage-wide success |
| Stage verify/observe | All required checks must succeed |
| Final state publication | Explicit clean proof links final state to last bound attempt; partial publication blocks |
| Metadata-only update | Preserve proof only from matching prior generation with clean state; retain exact current/previous hashes |
| Restore | Preflight all evidence and immutable decision before writing primary; preserve binding |
| Cleanup | Re-evaluate all evidence; only then remove marker |

Internal manifest clean proof is version 1, separate from the public state schema. It contains the exact last checkpoint sequence and the two recoverable clean snapshot hashes (current and previous). Starting any in-flight operation invalidates clean proof. Explicit final publication creates it only after stage verification and a safe, matching journal. Metadata updates propagate it only from the exact writer predecessor. Unknown newer generations cannot inherit an older clean proof.

Legacy manifests without clean proof remain readable with their existing exact-generation checks; recovery requires the historical exact checkpoint/state binding. Missing/uncertain legacy history is never fresh. No metadata is deleted to migrate legacy evidence. Read-only status reads recorded state without launching commands or repairing artifacts; plan, verify and status --refresh observe current inputs. S05 observation of an existing deployment includes bounded offline probes and deployed content hashing.

Physical power loss, privileged host qualification and process-tree cancellation are not established by this protocol or local fake adapters.

## Operation receipts and publication

The effect event contains a SHA-256 of the canonical typed receipt. `completed_operations` v1 carries that exact receipt, config hash and checkpoint identity; admission checks every retained receipt against the matching journal attempt/sequence/stage/operation/state hash and effect digest. A resource string alone grants no ownership. The engine clears in-flight only after effect evidence and operation verification, and persists the operation snapshot before appending/binding its checkpoint. A crash there still has an unresolved journal attempt and remains blocked. A completed group update can then publish `awaiting_manual` with no unknown mutation; the later resource probe has a read-only admission check before intent.

S02, S03, S04 and S05 have explicit `verifyOperation` callbacks. Simulation success is the completed simulation command result, followed by a clean dpkg observation; it does not claim packages are installed. S05 command success is only recorded by the actual probe operation. Stage-wide verify/observe is still mandatory after every selected operation and before `finalVerified` publication. For an existing S05 checkout, current command probes additionally require a journal-bound reviewed deployment receipt; an unproven commit marker yields a fresh gated deployment plan without executing its code during planning.

Prepared recovery stores the complete parsed source manifest. A restore of the exact last hash preserves it byte-for-byte; a restore of a clean metadata predecessor permits exactly generation+1, target hash and timestamp change, preserving all other proof. If primary rename succeeds before manifest publication, prepared continuation completes that same transition. Cleanup accepts only the immutable decision and its defined restore transition. Contradictory new quarantine/previous/journal/manifest evidence blocks before marker deletion. Legacy prepared decisions lacking source-manifest binding are retained and blocked; no implicit destructive migration is supplied.

S03 review inputs also bind bounded raw SSH config/drop-ins, UFW rules/config and rollback template content, file/directory uid/gid/mode/type, and critical manual evidence. The Node input observer refuses unsafe owner/write permissions, symlinks, unreadable mandatory inputs, more than 64 SSH include entries, over 256 KiB per file or over 2 MiB aggregate. Arming/staging marker files are excluded from this raw input inventory because they are operation-owned transitions, while their runtime postconditions remain in the observation hash.
