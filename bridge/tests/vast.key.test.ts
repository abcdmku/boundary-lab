/**
 * API key resolution precedence, and the guarantee that the key never leaks
 * into anything serializable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blab-vast-key-"));
process.env.DATA_DIR = path.join(tempDir, "data");

const { resolveKey, describeKey, defaultKeyFile, redact } = await import("../src/vast/key.ts");
const { config } = await import("../src/config.ts");

/** An env with every key source cleared, plus a key file pointed at a temp path. */
function cleanEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    VAST_API_KEY: undefined,
    VAST_API_KEY_FILE: path.join(tempDir, "nonexistent_key"),
    ...overrides,
  } as NodeJS.ProcessEnv;
}

test("key file path defaults under the user profile and honours the override", () => {
  const overridden = defaultKeyFile(cleanEnv({ VAST_API_KEY_FILE: "C:/keys/vast.txt" }));
  assert.equal(overridden, "C:/keys/vast.txt");

  const profiled = defaultKeyFile({ USERPROFILE: "C:/Users/Tester", HOME: "/home/tester" } as NodeJS.ProcessEnv);
  assert.equal(path.basename(profiled), ".vast_api_key");
  assert.ok(profiled.includes(process.platform === "win32" ? "Tester" : "tester"));
});

test("precedence 1: VAST_API_KEY wins over the key file and the config field", () => {
  const keyFile = path.join(tempDir, "precedence_key");
  fs.writeFileSync(keyFile, "key-from-file");
  config.vast.apiKey = "key-from-config";
  try {
    const resolved = resolveKey(cleanEnv({ VAST_API_KEY: "key-from-env", VAST_API_KEY_FILE: keyFile }));
    assert.equal(resolved.key, "key-from-env");
    assert.equal(resolved.source, "env");
  } finally {
    config.vast.apiKey = null;
  }
});

test("precedence 2: the key file wins over the config field", () => {
  const keyFile = path.join(tempDir, "file_only_key");
  fs.writeFileSync(keyFile, "key-from-file\n");
  config.vast.apiKey = "key-from-config";
  try {
    const resolved = resolveKey(cleanEnv({ VAST_API_KEY_FILE: keyFile }));
    assert.equal(resolved.key, "key-from-file");
    assert.equal(resolved.source, "file");
    assert.equal(resolved.path, keyFile);
  } finally {
    config.vast.apiKey = null;
  }
});

test("precedence 3: the config field is the last resort", () => {
  config.vast.apiKey = "key-from-config";
  try {
    const resolved = resolveKey(cleanEnv());
    assert.equal(resolved.key, "key-from-config");
    assert.equal(resolved.source, "config");
  } finally {
    config.vast.apiKey = null;
  }
});

test("no key anywhere resolves to none rather than throwing", () => {
  const resolved = resolveKey(cleanEnv());
  assert.equal(resolved.key, null);
  assert.equal(resolved.source, "none");
});

test("blank and whitespace-only sources are treated as absent", () => {
  const keyFile = path.join(tempDir, "blank_key");
  fs.writeFileSync(keyFile, "   \n\n");
  const resolved = resolveKey(cleanEnv({ VAST_API_KEY: "   ", VAST_API_KEY_FILE: keyFile }));
  assert.equal(resolved.key, null, "whitespace must not be mistaken for a key");
});

test("a key file written as an env assignment or quoted is still readable", () => {
  const assignment = path.join(tempDir, "assignment_key");
  fs.writeFileSync(assignment, 'export VAST_API_KEY="abc123def"\n# a comment line\n');
  assert.equal(resolveKey(cleanEnv({ VAST_API_KEY_FILE: assignment })).key, "abc123def");

  const quoted = path.join(tempDir, "quoted_key");
  fs.writeFileSync(quoted, "'abc123def'");
  assert.equal(resolveKey(cleanEnv({ VAST_API_KEY_FILE: quoted })).key, "abc123def");
});

test("describeKey reports a fingerprint, never the key", () => {
  const described = describeKey(cleanEnv({ VAST_API_KEY: "super-secret-key-value" }));
  assert.equal(described.configured, true);
  assert.equal(described.source, "env");
  assert.equal(described.fingerprint?.length, 8);
  const serialized = JSON.stringify(described);
  assert.ok(!serialized.includes("super-secret-key-value"), "describeKey must not serialize the key");
});

test("describeKey with no key is safe to render", () => {
  const described = describeKey(cleanEnv());
  assert.equal(described.configured, false);
  assert.equal(described.source, "none");
  assert.equal(described.fingerprint, null);
});

test("redact strips the live key, api_key params and bearer tokens", () => {
  const env = cleanEnv({ VAST_API_KEY: "abcdef0123456789" });
  assert.equal(redact("failed with key abcdef0123456789 in it", env), "failed with key <redacted> in it");
  assert.equal(redact("GET /x?api_key=deadbeef&y=1", env), "GET /x?api_key=<redacted>&y=1");
  assert.equal(redact("Authorization: Bearer sk-abc.def-123", env), "Authorization: Bearer <redacted>");
});
