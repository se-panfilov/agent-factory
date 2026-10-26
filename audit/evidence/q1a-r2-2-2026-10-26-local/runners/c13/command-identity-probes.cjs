// C13 fixture/input adapter. Original counters/oracles preserved; see adapter-map.md.
const __c13=require('../c13-fixture-compat.cjs')(process.argv[2]);
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const repo = path.resolve(process.argv[2]);
const { NodeApplicationReleaseAdapter, assertOfflineCommands } = require(path.join(repo, 'setup/dist/src/adapters/git.js'));
const { NodeFilesystemAdapter } = require(path.join(repo, 'setup/dist/src/adapters/filesystem.js'));
const { NodeProcessAdapter } = require(path.join(repo, 'setup/dist/src/adapters/process.js'));
const { validateContractSchema } = require(path.join(repo, 'setup/dist/src/core/validators.js'));
const { createApplicationStage } = require(path.join(repo, 'setup/dist/src/stages/application.js'));
const { stableStringify } = require(path.join(repo, 'setup/dist/src/core/config.js'));
const mode = process.argv[3] ?? 'adapter';
assert.ok(['adapter', 'stage'].includes(mode));
const results = [];
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function measure(id, entry, extraArgs = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'af-r15-command-'));
  const deployment = path.join(root, 'reviewed');
  const caller = path.join(root, 'caller');
  await fs.mkdir(deployment, { mode: 0o700 });
  await fs.mkdir(caller, { mode: 0o700 });
  const good = 'process.stdout.write("REVIEWED_ENTRY\\n");\n';
  const decoy = 'process.stdout.write("UNREVIEWED_CWD_ENTRY\\n");\n';
  await fs.writeFile(path.join(deployment, entry), good, { mode: 0o600 });
  await fs.writeFile(path.join(caller, entry), decoy, { mode: 0o600 });
  const config = { profile: 'supervised', github: { repository_allowlist: [] },
    release: { sha256: 'a'.repeat(64), source_commit: 'b'.repeat(40) },
    paths: { setup_node_dir: path.join(root, 'pinned-node'), application_dir: deployment } };
  await fs.mkdir(path.join(config.paths.setup_node_dir, 'bin'), { recursive: true, mode: 0o700 });
  await fs.symlink(process.execPath, path.join(config.paths.setup_node_dir, 'bin/node'));
  const argv = ['node', entry, ...extraArgs];
  const manifest = { schema_version: 1, application_version: 'm0.0.1', source_commit: 'b'.repeat(40),
    commands: { runner_verify: argv, runner_stop: argv }, content_hashes: { [entry]: hash(good) },
    node_range: '>=24.0.0 <25', capabilities: ['runner-readonly'], config_schema_version: 1,
    state_schema_version: 1, migrations: { from: 1, to: 1 }, security_evidence_refs: ['docs/security/m0.md'] };
  const schema = __c13.validate('application-manifest', manifest);
  assert.equal(schema.ok, true, __c13.stringify(schema));
  const invocations = [];
  const actualProcess = new NodeProcessAdapter();
  const proc = { hostIdentity:async()=>({os:"ubuntu-24.04",arch:"amd64"}),loginSessionId:async()=>"c13-fixture-owner-login", uid: () => process.getuid(), runCommand: async cmd => {
    if (cmd.binary === '/usr/bin/sha256sum') {
      return { exitCode: 0, stdout: hash(await fs.readFile(cmd.args[0])) + '  fixture\n', stderr: '', timedOut: false };
    }
    assert.equal(cmd.binary, path.join(config.paths.setup_node_dir, 'bin/node'));
    // Only run these exact locally authored, harmless stdout-only fixtures.
    // Use the current Node 24 runtime to exercise its real argv interpretation.
    // No product executable, sudo, daemon, credential or network operation runs.
    const originalCwd = process.cwd();
    process.chdir(caller);
    let output;
    try { output = await actualProcess.runCommand({ ...cmd, timeoutMs: 3000, maxOutputBytes: 16384 }); }
    finally { process.chdir(originalCwd); }
    invocations.push({ requested_binary: cmd.binary, args: cmd.args, cwd: cmd.cwd ?? null,
      synthetic_inherited_cwd: caller, actual_local_fixture_runtime: process.execPath,
      stdout: output.stdout, stderr: output.stderr, exit: output.exitCode });
    return output;
  } };
  const adapter = new NodeApplicationReleaseAdapter(proc, new NodeFilesystemAdapter());
  let validation = 'accepted', error = null, result = null;
  try {
    assertOfflineCommands(manifest, config);
    if (mode === 'adapter') result = await adapter.probeCommands(deployment, manifest, config);
    else {
      // Stage composition uses synthetic archive/checkout observations and a matching
      // receipt. Content checks, command preparation, and child execution stay real.
      adapter.observeExistingCheckout = async () => ({ exists: true, hasGitDir: false,
        dirty: false, detachedHead: true, branch: null, headCommit: manifest.source_commit,
        originUrl: null, hasDeploymentManifest: true, deployedSourceCommit: manifest.source_commit });
      adapter.inspectArchive = async () => ({ archiveExists: true, archiveSha256: config.release.sha256,
        sha256Matches: true, entryCount: 3, traversalEntries: [], symlinkEntries: [], specialEntries: [],
        hasDockerfile: true, hasBuildContext: true, manifestPath: 'deployment-manifest.json',
        manifest, manifestValid: true, manifestErrors: [] });
      const receipt = { operationId: 'reviewed-materialization', stageId: 'S05', resourceId: 'application-checkout',
        checks: {}, versions: { archive_sha256: config.release.sha256, source_commit: manifest.source_commit,
          release_manifest_hash: hash(__c13.canonical(manifest)) }, artifacts: [deployment] };
      const observation = await createApplicationStage(adapter).observe({ config, completedOperationReceipts: [receipt] });
      result = { stage_status: observation.status,
        deployed_content_and_commands_verified: observation.checks.deployed_content_and_commands_verified };
    }
  }
  catch (e) { validation = 'refused'; error = { code: e.code ?? null, message: e.publicMessage ?? e.message }; }
  const foreignOutput = invocations.some(x => /UNREVIEWED|UNBOUND_OPTION/.test(x.stdout));
  const row = { id, mode, entry, harness_ok: true, manifest_schema_valid: schema.ok, validation, error, result,
    hashed_path: path.join(deployment, entry), invocations, acceptance: !foreignOutput && (validation === 'refused' || invocations.every(x => x.stdout === 'REVIEWED_ENTRY\n')),
    real_privileged_or_network_commands: 0, local_stdout_only_node_children: invocations.length };
  results.push(row); console.log(__c13.stringify(row));
}
(async () => {
  await measure('W01_reviewed_js_positive', 'runner.js');
  await measure('W02_cjs_wrong_entry', 'runner.cjs');
  await measure('W03_extensionless_wrong_entry', 'runner');
  await measure('W04_node_eval_option', '--eval', ['process.stdout.write("UNBOUND_OPTION_EVAL\\n")', '--']);
  console.log(__c13.stringify({ id: 'META', node: process.version, uid: process.getuid(), mode, repo, cases: results.length, accepted: results.filter(r => r.acceptance).length,
    note: 'Harness completion is not product acceptance. Child execution restricted to authored stdout-only local fixtures; all privileged/network commands absent.' }));
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
