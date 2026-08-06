/**
 * Process entrypoint wiring the three faces together:
 *   - UI face:    static pages from bridge/ui + JSON API + SSE
 *   - agent face: POST /mcp (list_generators / generate / solve / …)
 *   - t3 face:    src/t3.ts client (solve wake-ups, spawn_thread)
 *
 * The UI never talks to t3 directly — it calls this backend, which holds the
 * bearer token. The HTTP API and the MCP tools call the same functions in
 * actions.ts: one code path.
 */
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, t3Configured } from "./config.ts";
import * as store from "./store.ts";
import * as queue from "./queue.ts";
import * as actions from "./actions.ts";
import { buildMcpServer } from "./mcp.ts";
import { refreshGenerators } from "./generators.ts";

store.loadStore();

// Graceful shutdown: kill active blabctl/Julia trees before exiting so a
// service-manager restart never leaves an orphan solve holding the GPU.
let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[bridge] ${signal}: terminating active jobs, then exiting`);
  queue.shutdownAll(`bridge shutdown (${signal})`);
  // Short grace so kill + state persistence land, then exit (the store's
  // process 'exit' hook does a final synchronous persist).
  setTimeout(() => process.exit(0), 1500);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const app = express();
app.use(express.json({ limit: "4mb" }));

const fail = (res: express.Response, err: unknown) => {
  const status = err instanceof actions.ActionError ? err.status : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
};

// ---------- agent face: MCP over streamable HTTP (stateless) ----------
app.post("/mcp", async (req, res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ---------- UI face: JSON API ----------
app.get("/api/state", (_req, res) => {
  res.json(actions.fullState());
});

app.post("/api/generators/refresh", async (_req, res) => {
  res.json(await refreshGenerators());
});

app.post("/api/generate", (req, res) => {
  const { generator, name, params } = req.body ?? {};
  if (typeof generator !== "string") return fail(res, new actions.ActionError("generator (string) is required"));
  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params)))
    return fail(res, new actions.ActionError("params must be an object"));
  try {
    res.json(actions.startGenerate({ generator, name, params }));
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/solve", (req, res) => {
  const { meshRunId, name, fmin, fmax, count, backend, symmetry } = req.body ?? {};
  if (typeof meshRunId !== "string") return fail(res, new actions.ActionError("meshRunId (string) is required"));
  const num = (v: unknown, label: string): number | undefined => {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new actions.ActionError(`${label} must be a number`);
    return n;
  };
  try {
    res.json(
      actions.startSolve({
        meshRunId,
        name,
        options: {
          fmin: num(fmin, "fmin"),
          fmax: num(fmax, "fmax"),
          count: num(count, "count"),
          backend: typeof backend === "string" ? backend : undefined,
          symmetry: typeof symmetry === "string" ? symmetry : undefined,
        },
      }),
    );
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/runs/:id/cancel", (req, res) => {
  try {
    res.json(actions.cancelRun(req.params.id));
  } catch (err) {
    fail(res, err);
  }
});

app.delete("/api/runs/:id", (req, res) => {
  try {
    actions.deleteRun(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/runs/:id/rescan", (req, res) => {
  try {
    res.json(actions.rescanRun(req.params.id));
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/runs/:id", (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: `unknown run ${req.params.id}` });
  res.json(run);
});

// live board: SSE — initial full state, then the changed run on every mutation
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "state", state: actions.fullState() })}\n\n`);
  const onChange = ({ runId }: { runId?: string }) => {
    const run = runId ? store.getRun(runId) : undefined;
    res.write(
      `data: ${JSON.stringify(run ? { type: "run", run } : { type: "state", state: actions.fullState() })}\n\n`,
    );
  };
  store.emitter.on("change", onChange);
  req.on("close", () => store.emitter.off("change", onChange));
});

// ---------- artifacts: files from a run's directory ----------
app.get("/artifacts/:runId/*", (req, res) => {
  const run = store.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "unknown run" });
  // Express already percent-decodes route params — decoding again here would
  // throw on literal % in filenames and misread %2F as a path separator.
  const rel = (req.params as Record<string, string>)["0"] ?? "";
  const dir = path.resolve(store.runDir(run.id));
  const file = path.resolve(dir, rel);
  if (path.relative(dir, file).startsWith("..")) return res.status(403).json({ error: "forbidden" });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile())
    return res.status(404).json({ error: "no such artifact" });
  res.sendFile(file);
});

// ---------- UI face: static pages ----------
const uiDistDir = path.join(config.bridgeRoot, "ui", "dist");
const uiDir = fs.existsSync(path.join(uiDistDir, "index.html")) ? uiDistDir : path.join(config.bridgeRoot, "ui");
app.use(express.static(uiDir));
// SPA-ish fallback: any other GET serves index.html (the UI owns routing)
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/mcp") || req.path.startsWith("/artifacts/"))
    return res.status(404).json({ error: "not found" });
  const index = path.join(uiDir, "index.html");
  if (fs.existsSync(index)) return res.sendFile(index);
  res
    .status(200)
    .type("text/plain")
    .send("boundary-bridge is running. UI not built yet (bridge/ui/index.html missing).");
});

app.listen(config.port, config.host, () => {
  console.log(`[bridge] listening on  ${config.host}:${config.port}`);
  console.log(`[bridge] ui + api      ${config.publicUrl}/`);
  console.log(`[bridge] mcp endpoint  ${config.publicUrl}/mcp`);
  console.log(`[bridge] blabctl       ${config.python} ${config.blabctl}`);
  console.log(
    `[bridge] t3 orchestration: ${
      t3Configured()
        ? config.t3BaseUrl
        : "NOT CONFIGURED (standalone mode — set T3_BASE_URL and T3_TOKEN for thread wake-ups/spawns)"
    }`,
  );
  void refreshGenerators().then((cache) => {
    console.log(
      cache.error
        ? `[bridge] generators: unavailable — ${cache.error}`
        : `[bridge] generators: ${cache.generators.map((g) => g.id).join(", ") || "(none)"}`,
    );
  });
});
