import { GeneratorCard } from "./GeneratorCard.jsx";
import { ToolsList } from "./ToolsList.jsx";

export function Rail({ generators }) {
  return (
    <aside className="sticky top-12 h-[calc(100vh-3rem)] w-70 shrink-0 overflow-y-auto border-r border-border p-4">
      <div className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        Generators
      </div>
      {(generators || []).map((g) => (
        <GeneratorCard key={g.id} generator={g} />
      ))}
      <ToolsList />
    </aside>
  );
}
