/**
 * Workspace -> thread correlation.
 * Copied essentially unchanged from the t3-mission-control reference bridge
 * (domain-independent).
 *
 * MCP tool calls don't carry a thread id. But t3 threads run in worktrees or
 * project roots, and the shell snapshot maps worktreePath -> thread. So a
 * tool that knows the agent's working directory can resolve which thread is
 * calling. Threads without a worktree fall back to the project's workspaceRoot.
 *
 * Without t3 configured, each workspace becomes a pseudo-thread so the bridge
 * still demos standalone.
 */
import path from "node:path";
import { t3Configured } from "./config.ts";
import { getShell, type ShellSnapshot, type ShellThread, type ModelSelection } from "./t3.ts";

export interface ResolvedThread {
  threadId: string;
  threadTitle: string;
  projectId: string | null;
  modelSelection: ModelSelection | null;
  live: boolean;
}

let cache: { shell: ShellSnapshot; at: number } | null = null;
const SHELL_TTL_MS = 10_000;

export async function shellSnapshot(): Promise<ShellSnapshot | null> {
  if (!t3Configured()) return null;
  if (cache && Date.now() - cache.at < SHELL_TTL_MS) return cache.shell;
  const shell = await getShell();
  cache = { shell, at: Date.now() };
  return shell;
}

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();

export async function resolveWorkspace(workspace: string): Promise<ResolvedThread> {
  const w = norm(workspace);
  const shell = await shellSnapshot().catch(() => null);
  if (shell) {
    const byWorktree = shell.threads.find(
      (t) => t.worktreePath !== null && norm(t.worktreePath) === w && t.archivedAt === null,
    );
    if (byWorktree) return liveThread(byWorktree);
    const project = shell.projects.find((p) => norm(p.workspaceRoot) === w);
    if (project) {
      // workspace root maps to the project's most recent worktree-less thread
      const t = shell.threads.find(
        (t) => t.projectId === project.id && t.worktreePath === null && t.archivedAt === null,
      );
      if (t) return liveThread(t);
      return {
        threadId: `project:${project.id}`,
        threadTitle: project.title,
        projectId: project.id,
        modelSelection: project.defaultModelSelection,
        live: false,
      };
    }
  }
  return {
    threadId: `standalone:${path.basename(w)}`,
    threadTitle: path.basename(workspace),
    projectId: null,
    modelSelection: null,
    live: false,
  };
}

const liveThread = (t: ShellThread): ResolvedThread => ({
  threadId: t.id,
  threadTitle: t.title,
  projectId: t.projectId,
  modelSelection: t.modelSelection,
  live: true,
});

export async function threadInfo(threadId: string): Promise<ShellThread | null> {
  const shell = await shellSnapshot().catch(() => null);
  return shell?.threads.find((t) => t.id === threadId) ?? null;
}
