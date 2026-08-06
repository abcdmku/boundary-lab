import { Fragment } from "react";

// Static reference, no interactivity — the six MCP tools this bridge
// exposes (bridge/src/mcp.ts), so a human glancing at the rail knows the
// AI's vocabulary without needing to ask.
const TOOLS = [
  ["list_generators", "Lists generators, ids, and schemas"],
  ["generate", "Runs a generator, builds a mesh"],
  ["solve", "Queues a BEM solve on mesh"],
  ["get_run", "Gets one run's status and artifacts"],
  ["list_runs", "Lists recent runs, newest first"],
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
