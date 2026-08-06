import { cn } from "../../lib/cn";

const MOD = {
  running: "run-dot--running",
  done: "run-dot--done",
  failed: "run-dot--failed",
  // queued / cancelled fall back to the muted base color
};

export function StatusDot({ status }) {
  const pulsing = status === "queued" || status === "running";
  return <span className={cn("run-dot", MOD[status], pulsing && "run-dot--pulse")} />;
}
