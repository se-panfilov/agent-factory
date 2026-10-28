#!/usr/bin/env python3
"""Independent exact-ID oracle for reviewer R3 remaining-gap measurements.
Baseline mode means defects reproduced, never product PASS. Harness faults exit70.
"""
import argparse
import json
from pathlib import Path

IDS = ["C-none", "C-valid", "C-stale", "C-legacy", "C-broken-json",
       "C-v2-missing-field", "C-v2-extra-field", "C-unknown-version", "E-control",
       "E-no-inventory", "E-empty-inventory", "E-return-failure", "E-throw-stop", "E-throw-after-prefix"]
BASELINE_RED = {"C-v2-missing-field", "C-v2-extra-field", "C-unknown-version",
                "E-no-inventory", "E-empty-inventory", "E-throw-stop", "E-throw-after-prefix"}


def check(file, mode):
    rows = [json.loads(s) for s in Path(file).read_text().splitlines() if s.strip()]
    assert [r.get("id") for r in rows] == IDS + ["META"], "IDs missing/duplicate/out of order"
    meta = rows.pop()
    assert meta["cases"] == 14 and meta["real_external_commands"] == 0
    out = []
    for r in rows:
        ident = r["id"]
        assert r["real_external_commands"] == 0
        if ident.startswith("C-"):
            assert r["hits"] == (0 if ident == "C-none" else 1)
            if ident != "C-none":
                assert r["before_counts"] == {"refresh": 0, "simulate": 0, "install": 0}
                assert r["original"]["schema_version"] == 2 and r["original"]["owner"]["nonce"]
                assert r["request_retained"] is True
            if ident in {"C-none", "C-stale", "C-legacy"}:
                safe = r["exit"] == 0 and r["counts"] == {"refresh": 1, "simulate": 1, "install": 1}
                safe = safe and r["target_events"] == ["intent", "effect", "verify", "checkpoint"] * 3
            else:
                safe = r["exit"] == (130 if ident == "C-valid" else 8)
                safe = safe and r["counts"] == {"refresh": 0, "simulate": 0, "install": 0} and r["target_events"] == []
        else:
            assert r["fixture_owned_container_running_before"] is True
            if ident == "E-control":
                safe = r["exit"] == 0 and not r["fixture_owned_container_running_after"] and r["paused"]
                assert r["docker_calls"] == 5 and r["stopped"] == ["a" * 12]
                assert r["data"]["skipped_foreign_containers"] == ["b" * 12]
            elif ident in {"E-no-inventory", "E-empty-inventory"}:
                safe = r["exit"] != 0 or not r["fixture_owned_container_running_after"]
                if mode == "baseline":
                    assert r["docker_calls"] == 0 and r["paused"]
            else:
                assert r["hits"] == 1
                if ident == "E-throw-after-prefix":
                    assert r["stopped"] == ["a" * 12] and r["docker_calls"] == 5
                safe = r["exit"] == 8 and r["paused"]
        assert r["desired_pass"] is bool(safe), "collector flag differs from independently recomputed predicate"
        out.append({"id": ident, "desired_pass": bool(safe), "exit": r["exit"]})
    red = {r["id"] for r in out if not r["desired_pass"]}
    assert meta["desired_pass"] == 14 - len(red)
    if mode == "baseline":
        assert red == BASELINE_RED
    return {"mode": mode, "cases": 14, "desired_pass": 14 - len(red), "desired_fail": len(red),
            "verdict": "BASELINE_CONFIRMED" if mode == "baseline" else ("PASS" if not red else "FAIL"), "rows": out}


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--mode", choices=["baseline", "desired"], required=True)
    p.add_argument("file")
    args = p.parse_args()
    try:
        result = check(args.file, args.mode)
    except Exception as e:
        print(json.dumps({"verdict": "HARNESS_INVALID", "error": str(e)}))
        raise SystemExit(70)
    print(json.dumps(result, indent=2))
    raise SystemExit(1 if args.mode == "desired" and result["desired_fail"] else 0)
