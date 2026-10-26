"""Product oracle for reviewer S03 continuation probes; harness exit0 is not acceptance."""
import argparse, json
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('log', type=Path)
p.add_argument('--expect', choices=['observed-r21', 'fixed'], required=True)
a = p.parse_args()
rows = [json.loads(line) for line in a.log.read_text().splitlines() if line.strip()]
assert len(rows) == 14 and rows[-1]['id'] == 'META'
data = rows[:-1]
assert len({row['id'] for row in data}) == 13
failures = []
checks = []
for row in data:
    name = row['id']
    control = name == 'S03-none-control' or name.startswith('S03-disarm-')
    expected_counts = {k: 0 if k == 'rollback' else 1 for k in row['after']}
    actual_exit = row['first_exit'] if row['next_exit'] is None else row['next_exit']
    product_ok = actual_exit == 0 and row['after'] == expected_counts and not row['timer_armed'] and row['stage_status'] == 'verified'
    assert row['acceptance'] == product_ok
    assert row['real_privileged_commands'] == 0
    if name != 'S03-none-control':
        assert row['first_exit'] == 130 and row['in_flight_before'] is None
        assert row['known_receipts'], 'The checkpoint must be genuinely committed.'
    if a.expect == 'observed-r21':
        if control:
            assert product_ok, name
        elif name.endswith('-resume'):
            assert row['next_exit'] == 4 and row['next_error'] in ['s03_observation_drifted', 'gate_not_approved']
            assert row['after'] == row['before'] and not product_ok
            if row['next_error'] == 's03_observation_drifted':
                assert row['evidence_before'] == row['evidence_after']
        else:
            assert row['next_exit'] == 0 and not product_ok
            assert any(row['after'][key] > 1 for key in ['install', 'stage', 'arm', 'cutover'])
    elif not product_ok:
        failures.append(name)
    checks.append({'id': name, 'desired_product_pass': product_ok, 'exit': actual_exit,
                   'error': row['next_error'], 'counts': row['after']})
print(json.dumps({'expectation': a.expect, 'cases': len(data), 'product_pass': sum(r['desired_product_pass'] for r in checks),
                  'product_fail': sum(not r['desired_product_pass'] for r in checks), 'failures': failures, 'rows': checks}, indent=2))
raise SystemExit(1 if failures else 0)
