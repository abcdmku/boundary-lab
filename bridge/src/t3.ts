/**
 * The t3code contract client — the bridge's hand into orchestration.
 * Copied essentially unchanged from the t3-mission-control reference bridge
 * (domain-independent).
 *
 * Speaks the plain-HTTP fallback of the t3 server contract
 * (packages/contracts/src/environmentHttp.ts in the t3code repo):
 *
 *   GET  /api/orchestration/shell     -> projects + threads (worktree mapping)
 *   POST /api/orchestration/dispatch  -> ClientOrchestrationCommand
 *
 * Auth is a scoped bearer token; mint one with
 *   t3 auth session issue --token-only
 * and export it as T3_TOKEN (needs orchestration:read + orchestration:operate).
 *
 * Command shapes track t3code's contracts (orchestration.ts). IDs are opaque
 * non-empty strings, so UUIDs are valid. Note: the WS path has a richer
 * `bootstrap` flow (auto worktree prep + setup script) that the HTTP dispatch
 * endpoint does not run — over HTTP we create the thread explicitly, then
 * start the turn.
 */
import crypto from "node:crypto";
import { config, t3Configured } from "./config.ts";

/** Client-upload image attachment (UploadChatImageAttachment in t3's contracts). */
export interface ImageAttachment {
  type: "image";
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  /** Canonical provider option selections, e.g. [{id:"effort",value:"high"}]. */
  options?: Array<{ id: string; value: string | boolean }>;
}

export interface ShellThread {
  id: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: string;
  interactionMode?: string;
  branch: string | null;
  worktreePath: string | null;
  archivedAt: string | null;
  updatedAt: string;
}

export interface ShellProject {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection: ModelSelection | null;
}

export interface ShellSnapshot {
  projects: ShellProject[];
  threads: ShellThread[];
}

async function t3Fetch(pathname: string, init?: RequestInit): Promise<unknown> {
  if (!t3Configured()) throw new Error("t3 is not configured (set T3_BASE_URL and T3_TOKEN)");
  const res = await fetch(`${config.t3BaseUrl}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.t3Token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`t3 ${pathname} -> ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

export const getShell = () => t3Fetch("/api/orchestration/shell") as Promise<ShellSnapshot>;

/**
 * Environment id from the server's public descriptor — needed to build web-UI
 * deep links (`/{environmentId}/{threadId}`). Cached after first success.
 */
let envIdCache: string | null = null;
export async function environmentId(): Promise<string | null> {
  if (!t3Configured()) return null;
  if (envIdCache) return envIdCache;
  try {
    const res = await fetch(`${config.t3BaseUrl}/.well-known/t3/environment`);
    const body = (await res.json()) as { environmentId?: string };
    envIdCache = body.environmentId ?? null;
  } catch {
    return null;
  }
  return envIdCache;
}

export const dispatch = (command: Record<string, unknown>) =>
  t3Fetch("/api/orchestration/dispatch", { method: "POST", body: JSON.stringify(command) });

/**
 * Start a turn on an existing thread — how the bridge talks INTO a chat
 * (solve wake-ups). The client dispatch schema requires
 * runtimeMode/interactionMode (server-side defaults don't apply over HTTP);
 * pass the thread's current modes so a nudge doesn't change them.
 */
export async function startTurn(
  threadId: string,
  text: string,
  opts?: {
    runtimeMode?: string;
    interactionMode?: string;
    attachments?: ImageAttachment[];
    modelSelection?: ModelSelection;
  },
) {
  return dispatch({
    type: "thread.turn.start",
    commandId: crypto.randomUUID(),
    threadId,
    message: {
      messageId: crypto.randomUUID(),
      role: "user",
      text,
      attachments: opts?.attachments ?? [],
    },
    ...(opts?.modelSelection ? { modelSelection: opts.modelSelection } : {}),
    runtimeMode: opts?.runtimeMode ?? "full-access",
    interactionMode: opts?.interactionMode ?? "default",
    createdAt: new Date().toISOString(),
  });
}

/** Create a new thread in a project and seed its first turn. The core of "spawn_thread". */
export async function spawnThread(input: {
  projectId: string;
  title: string;
  prompt: string;
  modelSelection: ModelSelection;
  attachments?: ImageAttachment[];
}): Promise<{ threadId: string }> {
  const threadId = crypto.randomUUID();
  await dispatch({
    type: "thread.create",
    commandId: crypto.randomUUID(),
    threadId,
    projectId: input.projectId,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  });
  await startTurn(threadId, input.prompt, { attachments: input.attachments });
  return { threadId };
}
