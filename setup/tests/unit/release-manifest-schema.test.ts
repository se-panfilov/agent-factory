import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SCHEMA_PATH = path.join(REPO_ROOT, "setup", "release-manifest.schema.json");

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
const validate = ajv.compile(schema);

function validManifest() {
  return {
    schema_version: 1,
    contract_version: "1.0.0",
    setup_version: "0.0.1",
    source_commit: "a".repeat(40),
    created_at: "1970-01-01T00:00:00.000Z",
    files: [
      {
        path: "bootstrap.sh",
        size_bytes: 42,
        sha256: "b".repeat(64)
      }
    ],
    versions_lock_sha256: "c".repeat(64),
    bootstrap_manifest_sha256: "d".repeat(64),
    archive: {
      file: "factory-setup-v0.0.1.tar.xz",
      sha256: "e".repeat(64),
      size_bytes: 1234
    },
    signature: {
      file: "factory-setup-v0.0.1.tar.xz.sig",
      algorithm: "openssl-dgst-sha256",
      key_id: "owner-release-key-2026"
    }
  };
}

test("accepts valid release manifest", () => {
  const manifest = validManifest();
  const ok = validate(manifest);
  assert.equal(ok, true, JSON.stringify(validate.errors ?? []));
});

test("rejects traversal paths", () => {
  const manifest = validManifest();
  manifest.files[0]!.path = "../escape";
  const ok = validate(manifest);
  assert.equal(ok, false);
});

test("rejects invalid commit and checksum shape", () => {
  const manifest = validManifest();
  manifest.source_commit = "not-a-commit";
  manifest.archive.sha256 = "bad";
  const ok = validate(manifest);
  assert.equal(ok, false);
});
