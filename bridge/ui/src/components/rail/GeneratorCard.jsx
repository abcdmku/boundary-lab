import { ChevronRight } from "lucide-react";
import { ExamplePrompt } from "./ExamplePrompt.jsx";

// Hand-written examples for the real generator ids; anything else (e.g. a
// generator id this build doesn't recognize) falls back to an auto-built
// example from its own schema so the rail never shows a blank prompt.
const PROMPT_EXAMPLES = {
  ath_waveguide:
    "Generate an ATH waveguide: 25.4 mm throat, 220×160 mm mouth, 90 mm long, then solve 500 Hz–10 kHz.",
  axisym_horn:
    "Generate a tractrix horn: 25.4 mm throat, 300 mm mouth, 200 mm long, then solve 300 Hz–16 kHz.",
};

function fmtVal(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return v.map(fmtVal).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function exampleFor(gen) {
  if (PROMPT_EXAMPLES[gen.id]) return PROMPT_EXAMPLES[gen.id];
  const props = (gen.params && gen.params.properties) || {};
  const names = Object.keys(props).slice(0, 3);
  if (!names.length) return `Generate a ${gen.title.toLowerCase()}, then solve.`;
  const bits = names.map((n) => {
    const s = props[n];
    if (s.default === undefined) return n;
    const unit = s.unit || s["x-unit"] || "";
    return `${n}=${fmtVal(s.default)}${unit ? " " + unit : ""}`;
  });
  return `Generate a ${gen.title.toLowerCase()} with ${bits.join(", ")}, then solve.`;
}

// A generator entry is title + description + a copyable example prompt behind
// a disclosure, plus the two ways to drive it by hand: one configured job, or
// a parameter sweep. Full param discovery is still the AI's job via
// list_generators over MCP — the human form lives in the dialogs, not here.
export function GeneratorCard({ generator, onConfigure, onSweep }) {
  return (
    <details className="group mb-1">
      <summary className="-mx-2 flex cursor-pointer list-none gap-1.5 rounded-md px-2 py-1.5 select-none hover:bg-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={14}
          aria-hidden
          className="mt-0.5 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-90"
        />
        <span className="min-w-0">
          <span className="block text-[13px] leading-snug font-medium break-words">
            {generator.title}
          </span>
          {generator.description && (
            <>
              <span className="mt-0.5 line-clamp-2 text-[12px] leading-snug break-words text-muted-foreground group-open:hidden">
                {generator.description}
              </span>
              <span className="mt-0.5 hidden text-[12px] leading-snug break-words text-muted-foreground group-open:block">
                {generator.description}
              </span>
            </>
          )}
        </span>
      </summary>
      {(onConfigure || onSweep) && (
        <div className="btn-group" style={{ margin: "4px 0 6px 20px" }}>
          {onConfigure && (
            <button type="button" className="btn btn--sm" onClick={onConfigure}>
              New job…
            </button>
          )}
          {onSweep && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onSweep}>
              Sweep…
            </button>
          )}
        </div>
      )}
      <ExamplePrompt text={exampleFor(generator)} />
    </details>
  );
}
