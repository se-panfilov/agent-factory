#!/usr/bin/env python3
"""Independent oracle. Exit 0 of the JS collector only means collection completed.

--mode baseline checks the exact observed 7 PASS / 7 FAIL result on R22/R221.
--mode desired checks the safe target, and intentionally exits 1 on both baselines.
Harness faults always exit 70. Adapt implementation-specific injection points in a
separate runner with a mapping; never change the product predicates below to green.
"""
import argparse
import json
import sys
from pathlib import Path

IDS = [
    "L-active", "L-known-dead", "L-unknown-start", "L-invalid-json",
    "L-invalid-shape", "L-recovery-race", "C-none", "C-early", "C-late",
    "C-atomic-control", "C-atomic-fault", "E-missing", "E-sudo", "E-root",
]
RED = {
    "L-unknown-start", "L-invalid-shape", "L-recovery-race", "C-late",
    "C-atomic-fault", "E-sudo", "E-root",
}


def check(filename, mode):
    rows = [json.loads(line) for line in Path(filename).read_text().splitlines() if line.strip()]
    assert [r.get("id") for r in rows] == IDS + ["META"], "missing/duplicate/out-of-order IDs"
    meta = rows.pop()
    assert meta["cases"] == 14 and meta["real_external_commands"] == 0
    results = []
    for r in rows:
        ident = r["id"]
        if ident.startswith("L-") and ident != "L-recovery-race":
            assert r["state_evidence_unchanged"] is True
            assert isinstance(r["owner_before"], str) and len(r["owner_before"]) == 64
            if ident == "L-known-dead":
                safe = r["result"]["exit"] == 0 and r["owner_after"] is None and r["data"]["quarantined"] is True
            else:
                safe = r["result"]["exit"] != 0 and r["owner_before"] == r["owner_after"]
        elif ident == "L-recovery-race":
            assert r["hits"] == 1 and r["replacement_owner"]["nonce"]
            safe = r["result"]["exit"] != 0 and (r["current_owner"] or {}).get("nonce") == r["replacement_owner"]["nonce"]
        elif ident in {"C-none", "C-early", "C-late"}:
            assert r["inflight"] is None
            if ident == "C-none":
                assert r["hits"] == 0
                safe = r["result"]["exit"] == 0 and r["counts"] == {"refresh": 1, "simulate": 1, "install": 1}
                safe = safe and [e["code"] for e in r["journal"]] == ["intent", "effect", "verify", "checkpoint"] * 3
            else:
                assert r["hits"] == 1 and r["beforeRequest"] == {"refresh": 0, "simulate": 0, "install": 0}
                assert r["request"]["target_lock_nonce"] and r["request"]["target_lock_pid"] > 0
                safe = r["result"]["exit"] == 130 and all(n == 0 for n in r["counts"].values()) and r["journal"] == []
        elif ident.startswith("C-atomic-"):
            assert r["hits"] == 1
            if ident == "C-atomic-fault":
                assert r["error"] == "ENOSPC", "fault injection did not hit"
            else:
                assert r["error"] is None
            safe = r["consumed"] is True
        else:
            assert r["real_commands"] == 0
            safe = r["result"]["exit"] != 0 and r["calls"] == []
            if mode == "baseline" and ident == "E-sudo":
                assert r["calls"] == [{"binary": "/usr/bin/sudo", "args": ["-n", "/usr/bin/true"], "timeoutMs": 20000, "maxOutputBytes": 131072}]
        assert r["desired_pass"] is safe, "collector boolean disagrees with independently computed predicate"
        results.append({"id": ident, "desired_pass": safe})
    passed = sum(r["desired_pass"] for r in results)
    assert meta["desired_pass"] == passed
    if mode == "baseline":
        assert {r["id"] for r in results if not r["desired_pass"]} == RED, "baseline changed"
    return {"file": str(filename), "mode": mode, "cases_complete": 14, "desired_pass": passed,
            "desired_fail": 14 - passed, "results": results,
            "verdict": "BASELINE_CONFIRMED" if mode == "baseline" else ("PASS" if passed == 14 else "FAIL")}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["baseline", "desired"], required=True)
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()
    try:
        result = [check(p, args.mode) for p in args.files]
    except Exception as exc:
        print(json.dumps({"verdict": "HARNESS_INCOMPLETE_OR_INVALID", "error": str(exc)}))
        return 70
    print(json.dumps(result, indent=2))
    return 1 if args.mode == "desired" and any(r["desired_fail"] for r in result) else 0


if __name__ == "__main__":
    sys.exit(main())
