# Qualification status and failure matrix (P15)

Status terms are strict:

- **ready for code review**: implementation and safe tests completed in repository.
- **offline verified**: unit/integration evidence complete, no paid/live actions required.
- **production qualified**: requires real VM fresh/second/reboot/recovery evidence + owner-approved live smoke + M0.

Current repository status after P15: **ready for code review = yes**, **offline verified = yes**, **production qualified = no**.

## Executed evidence (this repository)

- Unit/integration tests from `setup/tests/{unit,integration}`.
- Release archive build + checksum + detached signature validation.
- Contract lock/schema validation through existing setup tests.

## NOT RUN (blocked until owner-disposable VM + consent)

- Fresh VM install
- Second idempotent run on same VM
- Interrupted apply + resume
- Reboot recovery verification
- Network fault-injection on VM
- Disk pressure / ENOSPC on VM
- Missing sudo privileges path on VM
- Optional-stage failure admission on VM
- Emergency stop/restore live behavior
- OAuth live and paid cloud usage checks

## Comprehensive failure matrix (C11 + prompt §8/§9)

| Scenario | Detection | Expected exit/status | Safe next action |
|---|---|---|---|
| Wrong OS/arch/root bootstrap | bootstrap preflight checks | `3` | Use non-root owner on Ubuntu 24.04 amd64 |
| Node tarball hash/size/signature mismatch | bootstrap verification | `9` | Re-download from pinned URL and verify keyring |
| Symlink/path traversal in archive | bootstrap/release verify | `9` | Replace artifact and rebuild reviewed release |
| Missing required lock pins | schema/lock validation | `5` | Fix `versions.lock.json`, re-run plan/build |
| TLS/auth/download immutable pin unavailable | read-only fetch logic | `6` or `9` | Restore official source or update reviewed pin |
| Stale/foreign install lock | lock owner validation | `7` | Wait or run `recover --lock-only` after liveness check |
| Plan hash drift after config change | plan consistency check | `8` | Re-plan and re-approve gates |
| Verified state but resource absent | verify/observe reconciliation | `8` (`drifted`) | Re-observe, recover, then apply |
| Resource present but effect evidence/checkpoint chain is incomplete | journal/recovery reconciliation logic | `8` or recovered | Run recover path, preserve journal/marker evidence, adopt only after verified checkpoint |
| Gate revoked/expired/denied | gate checks | `4` | Re-approve gate for current plan hash |
| Cleanup failure on signal/cancel | cleanup trap / state write | `8` | Manual recovery, verify resources before resume |
| Inaccessible Docker/systemd | stage adapters probe | `3` or `5` | Restore host capability, rerun from plan |
| Changed user policy/config | policy drift detection | `4` or `8` | Review `.proposed` diff, approve or revert |
| Wrong pinned version on host | probe/version checks | `8` or `5` | Reinstall exact pin or update reviewed lock |
| Duplicate installer process | lock + cancel request flow | `7` | Keep one owner process, recover stale lock if needed |
| ENOSPC during state write/mutation | atomic write failure | `8` | Free disk, re-observe, resume only after reconcile |

## VM qualification harness

Use only with explicit owner consent and disposable host marker:

```bash
FACTORY_SETUP_OWNER_CONSENT=YES \
FACTORY_SETUP_VM_DISPOSABLE=YES \
setup/tests/vm/run-qualification.sh --host ubuntu@<vm-ip> --ssh-key ~/.ssh/<key>
```

The harness intentionally does not auto-provision infrastructure and does not auto-run destructive host changes.
