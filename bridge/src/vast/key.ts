/**
 * vast.ai API key resolution.
 *
 * Precedence (first hit wins):
 *   1. VAST_API_KEY environment variable
 *   2. the key file — %USERPROFILE%/.vast_api_key on Windows, ~/.vast_api_key
 *      elsewhere. This is where the official vast CLI stores its key, so a
 *      machine already set up for `vastai` needs no extra configuration.
 *      Override the path with VAST_API_KEY_FILE.
 *   3. config.vast.apiKey — the in-process config field, for embedders and
 *      tests. Null by default; nothing ever writes a key into it from disk.
 *
 * The key is NEVER logged, never persisted to state.json, and never placed in
 * a URL (the client authenticates with an Authorization header, so the key
 * cannot leak through a request log or an error message containing a URL).
 * Everything that reports on key availability goes through `describeKey`,
 * which returns a source label and a fingerprint — not the secret.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.ts";

export type KeySource = "env" | "file" | "config" | "none";

export interface KeyResolution {
  key: string | null;
  source: KeySource;
  /** For source "file": where it was read from. Never contains the key. */
  path?: string;
}

/** Default key-file location, mirroring the official vast CLI. */
export function defaultKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VAST_API_KEY_FILE) return env.VAST_API_KEY_FILE;
  // os.homedir() already resolves to %USERPROFILE% on Windows, but honour an
  // explicit USERPROFILE first so a test (or a service account) can redirect it.
  const home = process.platform === "win32" ? (env.USERPROFILE ?? os.homedir()) : (env.HOME ?? os.homedir());
  return path.join(home, ".vast_api_key");
}

/**
 * A vast key is a long hex string. Reject obvious non-keys (empty files, a
 * stray newline, a shell export line) rather than sending garbage upstream and
 * getting an opaque 401.
 */
function sanitize(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Tolerate `VAST_API_KEY=abc` or `export VAST_API_KEY=abc` in the key file.
  const assignment = /^(?:export\s+)?VAST_API_KEY\s*=\s*(.+)$/i.exec(trimmed);
  const value = (assignment ? assignment[1] : trimmed).trim().replace(/^["']|["']$/g, "");
  return value.length > 0 ? value : null;
}

export function resolveKey(env: NodeJS.ProcessEnv = process.env): KeyResolution {
  const fromEnv = sanitize(env.VAST_API_KEY);
  if (fromEnv) return { key: fromEnv, source: "env" };

  const file = defaultKeyFile(env);
  try {
    if (fs.existsSync(file)) {
      // Only the first line — the CLI writes a bare key, but a hand-edited
      // file often gains a trailing comment.
      const fromFile = sanitize(fs.readFileSync(file, "utf8").split(/\r?\n/)[0]);
      if (fromFile) return { key: fromFile, source: "file", path: file };
    }
  } catch {
    /* unreadable key file — fall through to the config field */
  }

  const fromConfig = sanitize(config.vast.apiKey);
  if (fromConfig) return { key: fromConfig, source: "config" };

  return { key: null, source: "none" };
}

/**
 * Safe-to-serialize description of the current key state. The fingerprint is
 * the first 8 hex chars of sha256(key) — enough to tell two keys apart in a
 * bug report, useless to an attacker.
 */
export function describeKey(env: NodeJS.ProcessEnv = process.env): {
  configured: boolean;
  source: KeySource;
  keyFile: string;
  fingerprint: string | null;
} {
  const resolved = resolveKey(env);
  return {
    configured: resolved.key !== null,
    source: resolved.source,
    keyFile: defaultKeyFile(env),
    fingerprint: resolved.key ? crypto.createHash("sha256").update(resolved.key).digest("hex").slice(0, 8) : null,
  };
}

/**
 * Strip anything that looks like a credential out of a string bound for a log
 * or an HTTP error body. Belt and braces: the client never puts the key in a
 * URL, but upstream error payloads have been known to echo request context.
 *
 * `extraSecrets` matters for a client constructed with an explicit key: that
 * key is not discoverable from the environment, so it has to be handed in or
 * an upstream error quoting it back would sail straight through.
 */
export function redact(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  extraSecrets: ReadonlyArray<string | null | undefined> = [],
): string {
  let out = text;
  for (const secret of [resolveKey(env).key, ...extraSecrets]) {
    if (typeof secret === "string" && secret.length >= 8) out = out.split(secret).join("<redacted>");
  }
  return out
    .replace(/(api_key=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, "$1<redacted>");
}
