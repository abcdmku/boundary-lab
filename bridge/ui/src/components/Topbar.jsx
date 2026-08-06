import { cn } from "../lib/cn";

export function Topbar({ connected }) {
  return (
    <header className="sticky top-0 z-2 flex h-12 items-center gap-2 border-b border-border bg-card px-4">
      <span
        className={cn("size-2 shrink-0 rounded-full bg-muted-foreground", connected && "bg-success")}
        title={connected ? "connected" : "disconnected"}
      />
      <h1 className="text-[13px] font-medium">Boundary Lab</h1>
    </header>
  );
}
