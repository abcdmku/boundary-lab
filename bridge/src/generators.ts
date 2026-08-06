/**
 * Generators registry — the catalog of mesh generators the python layer
 * exposes (`blabctl list-generators`).
 *
 * Fetched once on boot and on demand (POST /api/generators/refresh). If the
 * python layer isn't built yet or errors, the bridge still serves an empty
 * list plus the error string — it must boot regardless.
 *
 * Expected blabctl output (stdout): a single JSON document, either
 *   [ {id, title, description, params: <JSON Schema>}, ... ]
 * or {"generators": [...]}. A trailing NDJSON result event
 * {"type":"result","generators":[...]} is also accepted.
 */
import { execFile } from "node:child_process";
import { config } from "./config.ts";

export interface GeneratorInfo {
  id: string;
  title?: string;
  description?: string;
  /** JSON Schema for the generator's params object, passed through as-is. */
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GeneratorsCache {
  generators: GeneratorInfo[];
  error: string | null;
  fetchedAt: string | null;
}

let cache: GeneratorsCache = { generators: [], error: "not fetched yet", fetchedAt: null };

export const generatorsCache = (): GeneratorsCache => cache;
export const getGenerator = (id: string) => cache.generators.find((g) => g.id === id);

function extractList(parsed: unknown): GeneratorInfo[] | null {
  const list = Array.isArray(parsed)
    ? parsed
    : parsed !== null &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { generators?: unknown }).generators)
      ? (parsed as { generators: unknown[] }).generators
      : null;
  if (!list) return null;
  return list
    .filter((g): g is Record<string, unknown> => g !== null && typeof g === "object")
    .map((g) => ({ ...g, id: String(g.id ?? g.name ?? "") }))
    .filter((g) => g.id !== "");
}

function parseOutput(stdout: string): GeneratorInfo[] | null {
  const trimmed = stdout.trim();
  try {
    const list = extractList(JSON.parse(trimmed));
    if (list) return list;
  } catch {
    /* try NDJSON below */
  }
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) continue;
    try {
      const list = extractList(JSON.parse(t));
      if (list) return list;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

export function refreshGenerators(): Promise<GeneratorsCache> {
  return new Promise((resolve) => {
    execFile(
      config.python,
      [config.blabctl, "list-generators"],
      {
        cwd: config.repoRoot,
        env: { ...process.env, BLAB_JULIA_EXECUTABLE: config.juliaExecutable },
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          cache = {
            generators: [],
            error: `blabctl list-generators failed: ${err.message}${stderr ? ` — ${stderr.trim().slice(0, 500)}` : ""}`,
            fetchedAt: new Date().toISOString(),
          };
        } else {
          const list = parseOutput(stdout);
          cache = list
            ? { generators: list, error: null, fetchedAt: new Date().toISOString() }
            : {
                generators: [],
                error: `blabctl list-generators produced no parseable JSON generator list: ${stdout.trim().slice(0, 300)}`,
                fetchedAt: new Date().toISOString(),
              };
        }
        resolve(cache);
      },
    );
  });
}

/** Compact rows for MCP list_generators: names + defaults up front, full schema attached. */
export function compactGenerators() {
  return cache.generators.map((g) => {
    const schema = g.params ?? {};
    const properties =
      (schema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
    return {
      id: g.id,
      title: g.title ?? g.id,
      description: String(g.description ?? "").split(/\r?\n/)[0] ?? "",
      params: Object.entries(properties).map(([name, prop]) => ({
        name,
        ...(prop.default !== undefined ? { default: prop.default } : {}),
      })),
      schema,
    };
  });
}
