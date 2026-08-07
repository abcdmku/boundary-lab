import { Fragment } from "react";

// Static reference, no interactivity — the MCP tools this bridge exposes
// (bridge/src/mcp.ts), so a human glancing at the rail knows the AI's
// vocabulary without needing to ask.
const TOOLS = [
  ["list_generators", "Lists generators, ids, and schemas"],
  ["list_targets", "Lists local and remote compute"],
  ["generate", "Runs a generator, builds a mesh"],
  ["solve", "Queues one BEM solve on a mesh"],
  ["create_mesh_jobs", "Drafts meshes from param variants"],
  ["create_solve_jobs", "Drafts a solve sweep as one batch"],
  ["update_job", "Edits a draft before it launches"],
  ["launch_jobs", "Starts drafts by id or batch"],
  ["cancel_jobs", "Cancels jobs by id or batch"],
  ["delete_job", "Deletes a job and its artifacts"],
  ["get_job", "Gets one job's status and artifacts"],
  ["list_jobs", "Lists recent jobs, newest first"],
  ["spawn_thread", "Spawns a new t3 agent thread"],
];

export function ToolsList() {
  return (
    <>
      <div className="mt-6 mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        Tools
      </div>
      <div className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-1.5">
        {TOOLS.map(([name, desc]) => (
          <Fragment key={name}>
            <span className="font-mono text-[12px] leading-snug">{name}</span>
            <span className="text-[12px] leading-snug break-words text-muted-foreground">
              {desc}
            </span>
          </Fragment>
        ))}
      </div>
    </>
  );
}
