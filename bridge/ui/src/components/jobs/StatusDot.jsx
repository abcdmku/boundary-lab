import { cn } from "../../lib/cn";

const MOD = {
  running: "job-dot--running",
  done: "job-dot--done",
  failed: "job-dot--failed",
  // queued / cancelled fall back to the muted base color
};

export function StatusDot({ status }) {
  const pulsing = status === "queued" || status === "running";
  return <span className={cn("job-dot", MOD[status], pulsing && "job-dot--pulse")} />;
}
