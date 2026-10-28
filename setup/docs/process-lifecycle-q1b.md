# Q1B owned process lifecycle

Scope: local POSIX process groups of admitted installer children. This is not containment of malicious children that escape via setsid/daemonization, cgroups qualification, privileged execution or proof of Docker daemon workload cleanup. Ordinary-owner admission remains unchanged. Internal policy/signal objects are never decoded from public config, plans or cancellation JSON.

Each invocation registers a fresh run/operation/generation identity before asynchronous cancellation can lose its spawned child. Detached `spawn`, shell=false, establishes an owned group led by that child. Only its minted positive PGID is negated for group signals; no caller-supplied PID/PGID, kill(0), name-based cleanup or mutation selected by a process census exists. A group observed dead is never addressed again. A deterministic observer with a mismatched generation/unknown identity cannot authorize a signal.

States: registered → running → TERM → KILL → settled. Normal exit requires streams closed and no executing group member. A parent exit with held pipes gets 100 ms for normal stream drain, then residual-group termination. TERM covers the group. Production grace is **10,000 ms**; KILL is followed by **2,000 ms** maximum settle observation. Each group-facts observation has a250ms deadline; procfs reads are aborted on expiry and a late result cannot authorize signals. The 25 ms observation cadence bounds response latency without unbounded escalation timers. Normal command timeout is caller-owned, finite and positive; maximum supported timeout is 2,147,000,000 ms and output budget16 MiB. Cleanup checks group absence (ESRCH), or Linux read-only bounded procfs evidence of only zombies/dead members, together with closed child I/O. EPERM/unreadable/mismatched facts are unknown. These local group semantics rely on the OS and cooperative, non-escaping children; hostile PID/FS manipulation is outside Q1B. Unknown cleanup is never inferred safe from parent exit, a successful signal syscall or elapsed grace.

The settle loop alone owns transitions/timers. Abort only records the first reason and wakes it. It removes listeners/timers on settlement. Actual numeric exit (including null) and signal are separate. Spawn ENOENT/EACCES has no target and retains null exit. `commandSucceeded` rejects timeout, output overflow/invalid UTF8, cancellation, residual descendants and unknown cleanup even when a child exits0.

One shared stdout+stderr raw retention budget is enforced during reads. Two fixed-capacity buffers (at most2× budget allocation, total retained bytes ≤budget) avoid per-chunk metadata growth. Both streams share the budget; truncation marker is included in returned bytes. UTF8 is decoded after bounded retention, split codepoints are preserved and a trailing partial codepoint is dropped. Malformed complete output sets outputInvalid and cannot authenticate machine facts. Synthetic bearer/token/PEM markers are redacted across chunk splits before returning bounded output. This is finite known-pattern redaction, not universal secret recognition. Command argv/env/raw output are absent from lifecycle errors and durable process cleanup evidence.

## Internal caller matrix

All callers pass a closed policy. The actual Node adapter refuses critical policy before spawn; fakes retain their explicit resource/receipt contract. There are no automatic retries.

| Caller | Policy and decision | Env source | Bounds |
|---|---|---|---|
| apt | observe for queries; critical for sudo mutation. Node independently refuses apt/dpkg/privileged mutation without a qualified supervisor | none | existing observe/mutation constants + shared cap |
| access | observe for probes, critical for sudo; no Q1B SSH/UFW mutation qualification | none | existing stage bounds |
| docker | observe for inspection; critical sudo/build/run/rm/pull | none | existing stage bounds |
| git/application | interruptible reviewed absolute commands in owned release; success uses full result | none | existing hash/probe bounds |
| configuration | interruptible local probes/git; Docker build critical, digest/id inspection interruptible | fixed deterministic git dates only | existing stage bounds |
| verification | read-only git/inspect interruptible; Docker create/cleanup critical | none | existing stage bounds |
| auth | reviewed probes interruptible; Docker login critical | none | existing stage bounds |
| project | interruptible local git | none | existing stage bounds |
| inference | local probes observe; Docker compose and JSON scheduling-disable adapter critical. Node safety policy also rejects unsafe privileged commands. Daemon workload semantics remain unqualified | none | existing stage bounds |
| systemd/service | observe for queries/app-status; critical sudo and other real systemctl mutation blocked independently | service FACTORY_* env is refused by generic real adapter; service is unqualified | existing stage bounds |
| backup/update | critical, typed5 before real spawn | none | existing operation bounds |
| health | observe; full result required | none | existing health bounds |
| emergency | interruptible trusted stop/status and fixed Docker CLI argv; verified postconditions remain mandatory, CLI cleanup alone never proves resource stop | none | min(20s, remaining attempt budget),128 KiB |

No ambient env inheritance. PATH is always `/usr/bin:/bin:/usr/sbin:/sbin`; historical explicit PATH override is ignored. LC_ALL=C is fixed. Explicit allowed env: HTTP_PROXY/HTTPS_PROXY (or lowercase), credential-free http(s) authority only; NO_PROXY/no_proxy closed host list; SSL_CERT_FILE/SSL_CERT_DIR/NODE_EXTRA_CA_CERTS canonical absolute reference paths; GIT_TERMINAL_PROMPT=0; fixed GIT_AUTHOR_DATE/GIT_COMMITTER_DATE=2020-01-01T00:00:00Z for existing local toy fixture. Values ≤4096 bytes, no NUL/newline, conflicting case variants refused. These reference paths are internal reviewed inputs, not arbitrary public capabilities. No TLS bypass, NODE_OPTIONS/NODE_PATH, LD_*/DYLD_*, shell startup, arbitrary Git hooks/config or Docker endpoint/context passthrough. The baseline demonstrated an explicit internal env gap, not a remote exploitation chain.

## Cancellation and persistence

CLI installs SIGINT/SIGTERM handlers for the production engine lifecycle; first reason wins, repeated signals cannot bypass cleanup. JSON uses drained Node stdout and exitCode, not process.exit. StageContext exposes notification only. Existing generation-bound durable cancel reads remain authoritative. During an admitted operation a serial100ms observer with a1000ms bounded read joins before checkpoint; it forwards matching requests to the active supervisor. Before admission all disk reads finish before the unchanged finite R221 metadata fence/TTL/gates; only synchronous lifecycle checks follow that fence. No new async authorization reads were inserted there.

No effects before intent =>130/143 after confirmed release. Confirmed receipt/checkpoint prefix is retained before cancellation, and explicit resume does not replay it. Interrupted/unknown resource outcome =>8 and in-flight remains. Critical fake operation is observed at its safe boundary, never timer-killed/retried. Unknown group cleanup retains the installation lock and publishes process-cleanup-required.json (installation/full lock generation/run/operation/owned PID identities only). If publication fails, lock still stays and outcome8 wins. This marker blocks both fresh acquisition and takeover; automatic clearing is unsupported. Reconciliation is manual, not an invented privileged supervisor.

## Emergency attempt budget

Q1B chooses one **60,000 ms monotonic attempt budget** (an implementation choice, not a preexisting CONTRACT duration), including admission reads. Each FS await and every dispatch is fenced by remaining budget; late completion grants no new dispatch. Commands use min(20,000 ms, remaining). On deadline/abort the active permitted CLI is notified, with at most12,750ms supervisor cleanup grace; failure observations get a separate2,000ms budget. These are not renewals of effect admission. An underlying FS syscall may complete after timeout: PAUSED is therefore not_published/published_unconfirmed/durable only according to actual observed evidence; unknown stays unknown. PAUSED and confirmed prefix are retained. No automatic retry or next resource starts after expiration. Service/missing-status and foreign/unknown ownership boundaries remain intact.

## Qualification

Local real-child tests exercise POSIX groups, production10s escalation, held pipes and unrelated owned group safety. Engine/CLI harnesses inject external resource facts and application UID1000; actual OS UID is recorded separately. Linux/root-isolated execution and real sudo/APT/dpkg/SSH/UFW/systemd/Docker/cgroups/network/provider/VPS checks require separate qualification and are NOT RUN in this macOS workspace. O01 remains honest8/fresh review/no replay. O02 historical cause remains OPEN.
