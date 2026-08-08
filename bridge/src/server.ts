/**
 * Process entrypoint wiring the three faces together:
 *   - UI face:    static pages from bridge/ui + JSON API + SSE
 *   - agent face: POST /mcp (list_generators / generate / solve / …)
 *   - t3 face:    src/t3.ts client (solve wake-ups, spawn_thread)
 *
 * The UI never talks to t3 directly — it calls this backend, which holds the
 * bearer token. The HTTP API and the MCP tools call the same functions in
 * actions.ts: one code path.
 *
 * HTTP surface (see bridge/README.md for the full contract):
 *   GET    /api/state
 *   POST   /api/generators/refresh
 *   GET    /api/targets
 *   PATCH  /api/targets/:id               slot count / GPU pinning
 *   POST   /api/generate                  launch a mesh job now
 *   POST   /api/solve                     launch a solve job now
 *   GET    /api/jobs                      list (filterable)
 *   POST   /api/jobs                      create ONE draft
 *   POST   /api/jobs/batch                create a sweep (optionally launched)
 *   POST   /api/jobs/launch               launch drafts by ids and/or batchId
 *   POST   /api/jobs/hold                 queued -> draft (the undo for launch)
 *   POST   /api/jobs/cancel               cancel by ids and/or batchId
 *   GET    /api/jobs/:id
 *   PATCH  /api/jobs/:id                  edit a draft
 *   DELETE /api/jobs/:id
 *   POST   /api/jobs/:id/launch
 *   POST   /api/jobs/:id/cancel
 *   POST   /api/jobs/:id/rescan
 *   POST   /api/jobs/:id/variant          derive a new mesh from this mesh
 *   GET    /api/projects
 *   POST   /api/projects
 *   PATCH  /api/projects/:id
 *   DELETE /api/projects/:id              unassigns its jobs, never deletes them
 *   POST   /api/projects/assign           move jobs between projects
 *   POST   /api/schedule                  drag-and-drop moves (the board)
 *   POST   /api/schedule/lane             rewrite one lane's waiting order
 *   GET    /api/batches
 *   GET    /api/batches/:batchId
 *   POST   /api/batches/:batchId/launch
 *   POST   /api/batches/:batchId/cancel
 *   DELETE /api/batches/:batchId
 *   GET    /api/events                    SSE
 *   POST   /api/preview                   live mesh editor: render params now
 *   GET    /api/preview/:session/:seq/:f  the STLs that preview produced
 *   DELETE /api/preview/:session          drop an editor's scratch geometry
 *   /api/vast/*                           rented vast.ai GPUs (see src/vast/routes.ts)
 *   GET    /artifacts/:jobId/*            files from a job's directory
 */
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, t3Configured } from "./config.ts";
import * as store from "./store.ts";
import * as queue from "./queue.ts";
import * as actions from "./actions.ts";
import * as preview from "./preview.ts";
import { listTargets } from "./targets.ts";
import { buildMcpServer } from "./mcp.ts";
import { refreshGenerators } from "./generators.ts";
import { vastRouter } from "./vast/routes.ts";
import { registerVastTargets } from "./vast/targets.ts";

store.loadStore();
// Rented instances become selectable execution targets (and their own queue
// lanes). Registering here keeps src/targets.ts provider-agnostic.
registerVastTargets();

// Graceful shutdown: kill active blabctl/Julia trees before exiting so a
// service-manager restart never leaves an orphan solve holding the GPU.
let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[bridge] ${signal}: terminating active jobs, then exiting`);
  queue.shutdownAll(`bridge shutdown (${signal})`);
  preview.shutdownPreview();
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

/** Run a handler, turning ActionError into its HTTP status. */
const guard = (res: express.Response, fn: () => unknown) => {
  try {
    const value = fn();
    res.json(value === undefined ? { ok: true } : value);
  } catch (err) {
    fail(res, err);
  }
};

const asObject = (value: unknown, label: string): Record<string, unknown> | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new actions.ActionError(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const asStringArray = (value: unknown, label: string): string[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new actions.ActionError(`${label} must be an array of strings`);
  return value as string[];
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

/** Execution targets available right now: always local, plus registered remotes. */
app.get("/api/targets", (_req, res) => {
  res.json({ targets: listTargets() });
});

/**
 * How many solves this target runs at once, and which GPU each slot gets.
 * `{ slots: null }` / `{ devices: null }` clears an override.
 */
app.patch("/api/targets/:id", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  guard(res, () =>
    actions.setTargetSlots(req.params.id, {
      ...(body.slots !== undefined
        ? { slots: body.slots === null ? null : Number(body.slots) }
        : {}),
      ...(body.devices !== undefined
        ? { devices: body.devices === null ? null : asStringArray(body.devices, "devices") ?? null }
        : {}),
    }),
  );
});

app.post("/api/generate", (req, res) => {
  const { generator, name, params, batchId } = req.body ?? {};
  if (typeof generator !== "string")
    return fail(res, new actions.ActionError("generator (string) is required"));
  guard(res, () =>
    actions.startGenerate({
      generator,
      name,
      params: asObject(params, "params"),
      ...(typeof req.body?.project === "string" ? { project: req.body.project } : {}),
      ...(typeof req.body?.variantOf === "string" ? { variantOf: req.body.variantOf } : {}),
      ...(typeof batchId === "string" ? { batchId } : {}),
    }),
  );
});

app.post("/api/solve", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const meshJobId = body.meshJobId;
  if (typeof meshJobId !== "string")
    return fail(res, new actions.ActionError("meshJobId (string) is required"));
  guard(res, () =>
    actions.startSolve({
      meshJobId,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      options: actions.readSolveOptions(body),
      target: body.target,
      ...(typeof body.batchId === "string" ? { batchId: body.batchId } : {}),
    }),
  );
});

// ----- jobs -----
app.get("/api/jobs", (req, res) => {
  const { kind, status, batchId, parentJobId, limit } = req.query as Record<string, string>;
  let jobs = store.listJobs();
  if (kind) jobs = jobs.filter((j) => j.kind === kind);
  if (status) {
    const wanted = new Set(status.split(","));
    jobs = jobs.filter((j) => wanted.has(j.status));
  }
  if (batchId) jobs = jobs.filter((j) => j.batchId === batchId);
  if (parentJobId) jobs = jobs.filter((j) => j.parentJobId === parentJobId);
  const n = Number(limit);
  if (Number.isFinite(n) && n > 0) jobs = jobs.slice(0, n);
  res.json({ jobs });
});

/** Create ONE configured-but-unlaunched job. */
app.post("/api/jobs", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  guard(res, () =>
    actions.createDraft({
      kind: body.kind as store.JobKind,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.generator === "string" ? { generator: body.generator } : {}),
      params: asObject(body.params, "params"),
      ...(typeof body.meshJobId === "string" ? { meshJobId: body.meshJobId } : {}),
      options: actions.readSolveOptions(body),
      target: body.target,
      ...(typeof body.project === "string" ? { project: body.project } : {}),
      ...(typeof body.variantOf === "string" ? { variantOf: body.variantOf } : {}),
      ...(typeof body.batchId === "string" ? { batchId: body.batchId } : {}),
      ...(typeof body.batchName === "string" ? { batchName: body.batchName } : {}),
    }),
  );
});

/** Create a sweep: meshJobIds × variants (see actions.createBatch). */
app.post("/api/jobs/batch", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  guard(res, () => {
    const variants = body.variants;
    if (variants !== undefined && !Array.isArray(variants))
      throw new actions.ActionError("variants must be an array of objects");
    return actions.createBatch({
      kind: body.kind as store.JobKind,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.batchId === "string" ? { batchId: body.batchId } : {}),
      launch: body.launch === true,
      target: body.target,
      ...(typeof body.project === "string" ? { project: body.project } : {}),
      ...(typeof body.meshJobId === "string" ? { meshJobId: body.meshJobId } : {}),
      ...(asStringArray(body.meshJobIds, "meshJobIds")
        ? { meshJobIds: asStringArray(body.meshJobIds, "meshJobIds") }
        : {}),
      options: actions.readSolveOptions(body),
      ...(typeof body.generator === "string" ? { generator: body.generator } : {}),
      params: asObject(body.params, "params"),
      ...(variants ? { variants: variants as actions.BatchVariant[] } : {}),
    });
  });
});

/** Launch drafts by explicit ids and/or a whole batch. */
app.post("/api/jobs/launch", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  guard(res, () =>
    actions.launchJobs({
      ...(asStringArray(body.jobIds, "jobIds") ? { jobIds: asStringArray(body.jobIds, "jobIds") } : {}),
      ...(typeof body.batchId === "string" ? { batchId: body.batchId } : {}),
    }),
  );
});

/** Cancel by explicit ids and/or a whole batch. */
app.post("/api/jobs/cancel", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  guard(res, () =>
    actions.cancelJobs({
      ...(asStringArray(body.jobIds, "jobIds") ? { jobIds: asStringArray(body.jobIds, "jobIds") } : {}),
      ...(typeof body.batchId === "string" ? { batchId: body.batchId } : {}),
    }),
  );
});

/** Queued -> draft. Undoes a launch without destroying the configuration. */
app.post("/api/jobs/hold", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  guard(res, () =>
    actions.holdJobs({
      ...(asStringArray(body.jobIds, "jobIds") ? { jobIds: asStringArray(body.jobIds, "jobIds") } : {}),
      ...(typeof body.batchId === "string" ? { batchId: body.batchId } : {}),
    }),
  );
});

app.post("/api/jobs/:id/launch", (req, res) => {
  guard(res, () => actions.launchJobs({ jobIds: [req.params.id] }));
});

/** Derive a new mesh from this one — same generator, patched params. */
app.post("/api/jobs/:id/variant", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  guard(res, () =>
    actions.createMeshVariant({
      meshJobId: req.params.id,
      params: asObject(body.params, "params"),
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.project === "string" ? { project: body.project } : {}),
      launch: body.launch === true,
    }),
  );
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  guard(res, () => actions.cancelJob(req.params.id));
});

app.post("/api/jobs/:id/rescan", (req, res) => {
  guard(res, () => actions.rescanJob(req.params.id));
});

app.patch("/api/jobs/:id", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  guard(res, () =>
    actions.updateDraft(req.params.id, {
      ...(body.name !== undefined ? { name: String(body.name) } : {}),
      ...(typeof body.generator === "string" ? { generator: body.generator } : {}),
      ...(body.params !== undefined ? { params: asObject(body.params, "params") } : {}),
      ...(typeof body.meshJobId === "string" ? { meshJobId: body.meshJobId } : {}),
      ...(body.options !== undefined || actions.SOLVE_OPTION_KEYS.some((k) => body[k] !== undefined)
        ? { options: actions.readSolveOptions(body) }
        : {}),
      ...(body.target !== undefined ? { target: body.target } : {}),
      ...(body.batchId !== undefined
        ? { batchId: body.batchId === null ? null : String(body.batchId) }
        : {}),
      ...(typeof body.batchName === "string" ? { batchName: body.batchName } : {}),
    }),
  );
});

app.delete("/api/jobs/:id", (req, res) => {
  guard(res, () => {
    actions.deleteJob(req.params.id);
    return { ok: true };
  });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: `unknown job ${req.params.id}` });
  res.json({ ...job, lane: queue.laneOf(job.id), queuePosition: queue.queuePosition(job.id) });
});

// ----- projects: the design a mesh family and its solves belong to -----
app.get("/api/projects", (_req, res) => {
  res.json({ projects: store.listProjects() });
});

app.post("/api/projects", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  guard(res, () =>
    actions.createProject({
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.goal === "string" ? { goal: body.goal } : {}),
      ...(body.color !== undefined ? { color: Number(body.color) } : {}),
    }),
  );
});

app.patch("/api/projects/:id", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  guard(res, () =>
    actions.updateProject(req.params.id, {
      ...(body.name !== undefined ? { name: String(body.name) } : {}),
      ...(body.goal !== undefined ? { goal: body.goal === null ? null : String(body.goal) } : {}),
      ...(body.color !== undefined ? { color: Number(body.color) } : {}),
      ...(body.archived !== undefined ? { archived: body.archived === true } : {}),
    }),
  );
});

app.delete("/api/projects/:id", (req, res) => {
  guard(res, () => actions.deleteProject(req.params.id));
});

/** Move jobs into a project (or out of every project with projectId: null). */
app.post("/api/projects/assign", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  guard(res, () => {
    const jobIds = asStringArray(body.jobIds, "jobIds") ?? [];
    if (jobIds.length === 0) throw new actions.ActionError("jobIds is required");
    if (body.projectId !== null && typeof body.projectId !== "string")
      throw new actions.ActionError("projectId must be a string, or null to unassign");
    return actions.assignProject(jobIds, body.projectId as string | null);
  });
});

// ----- the schedule board -----
/** Drag-and-drop: [{ jobId, column, position }] where column is a target id
 *  or "planned". One card per entry so concurrent edits merge. */
app.post("/api/schedule", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  guard(res, () => {
    const raw = Array.isArray(body.moves) ? body.moves : [body];
    const moves = raw.map((entry) => {
      const move = (entry ?? {}) as Record<string, unknown>;
      if (typeof move.jobId !== "string" || typeof move.column !== "string")
        throw new actions.ActionError("each move needs { jobId, column }");
      return {
        jobId: move.jobId,
        column: move.column,
        ...(move.position !== undefined ? { position: Number(move.position) } : {}),
      };
    });
    return actions.scheduleJobs(moves);
  });
});

/** Rewrite one lane's whole waiting order in a single request. */
app.post("/api/schedule/lane", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  guard(res, () => {
    if (typeof body.laneKey !== "string") throw new actions.ActionError("laneKey is required");
    return actions.reorderLane(body.laneKey, asStringArray(body.jobIds, "jobIds") ?? []);
  });
});

// ----- batches -----
app.get("/api/batches", (_req, res) => {
  res.json({ batches: actions.listBatches() });
});

app.get("/api/batches/:batchId", (req, res) => {
  const summary = actions.batchSummary(req.params.batchId);
  if (!summary) return res.status(404).json({ error: `unknown batch ${req.params.batchId}` });
  res.json({ ...summary, jobs: store.listBatch(req.params.batchId) });
});

app.post("/api/batches/:batchId/launch", (req, res) => {
  guard(res, () => actions.launchJobs({ batchId: req.params.batchId }));
});

app.post("/api/batches/:batchId/cancel", (req, res) => {
  guard(res, () => actions.cancelJobs({ batchId: req.params.batchId }));
});

app.delete("/api/batches/:batchId", (req, res) => {
  guard(res, () => actions.deleteBatch(req.params.batchId));
});

// live board: SSE — initial full state, then the changed job on every mutation
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "state", state: actions.fullState() })}\n\n`);
  const onChange = ({ jobId }: { jobId?: string }) => {
    const job = jobId ? store.getJob(jobId) : undefined;
    res.write(
      `data: ${JSON.stringify(job ? { type: "job", job } : { type: "state", state: actions.fullState() })}\n\n`,
    );
  };
  store.emitter.on("change", onChange);
  req.on("close", () => store.emitter.off("change", onChange));
});

// ---------- compute providers: rented vast.ai GPUs ----------
app.use("/api/vast", vastRouter);

// ---------- live mesh editor: preview geometry, outside the job queue ----------
// A preview is not a job (see src/preview.ts): no board row, no run directory,
// and it must never wait behind a queued solve.
app.post("/api/preview", async (req, res) => {
  const { sessionId, generator, params } = req.body ?? {};
  try {
    const result = await preview.requestPreview({
      sessionId,
      generator,
      params: asObject(params, "params") ?? {},
    });
    res.json(result);
  } catch (err) {
    const status = err instanceof preview.PreviewError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/preview/:sessionId/:seq/:file", (req, res) => {
  const file = preview.resolvePreviewFile(req.params.sessionId, req.params.seq, req.params.file);
  if (!file) return res.status(404).json({ error: "no such preview" });
  // Each generation gets its own directory, so a URL's contents never change.
  res.setHeader("Cache-Control", "private, max-age=300, immutable");
  res.sendFile(file);
});

app.delete("/api/preview/:sessionId", (req, res) => {
  if (!preview.SESSION_ID_RE.test(req.params.sessionId))
    return res.status(400).json({ error: "bad sessionId" });
  preview.dropSession(req.params.sessionId);
  res.json({ ok: true });
});

// ---------- artifacts: files from a job's directory ----------
// The /artifacts/<id>/… path shape is frozen: artifact URLs are embedded in
// persisted job summaries and campaign logs from before the run→job rename.
app.get("/artifacts/:jobId/*", (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "unknown job" });
  // Express already percent-decodes route params — decoding again here would
  // throw on literal % in filenames and misread %2F as a path separator.
  const rel = (req.params as Record<string, string>)["0"] ?? "";
  const dir = path.resolve(store.jobDir(job.id));
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
  console.log(`[bridge] targets       ${listTargets().map((t) => t.id).join(", ")}`);
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
