import { AlertTriangle, Cpu } from "lucide-react";
import { cn } from "../../lib/cn";

/** How many empty pips to offer past the current count, as an invitation. */
const SPARE = 2;

/**
 * A target's slot count, as a row of pips you can click.
 *
 * This is the whole "how do jobs share this machine" control: filled pips are
 * running, hollow pips are free slots, ghost pips are slots you could add.
 * Clicking pip N sets the slot count to N+1 — no stepper, no number field, no
 * sentence explaining it. Clicking the last filled pip drops back to that
 * count, so it reads as a level, not a counter.
 *
 * The warning is the one place words are worth it: two solves sharing one card
 * share its VRAM, and a mesh that fits alone can fail alongside another. Pin a
 * device per slot and the warning goes away, because then they do not share.
 */
export function SlotPips({ column, onSetSlots, disabled }) {
  const { target, slotsUsed, slots } = column;
  const devices = target.devices || [];
  const shared = slots > 1 && devices.length < slots;
  const total = target.slotsLocked ? slots : Math.min(16, slots + SPARE);

  return (
    <div className="slotbar">
      <div
        className="slotpips"
        role="group"
        aria-label={`${target.label}: ${slotsUsed} of ${slots} slots busy`}
      >
        {Array.from({ length: total }, (_, i) => {
          const busy = i < slotsUsed;
          const real = i < slots;
          const device = devices[i];
          return (
            <button
              key={i}
              type="button"
              className={cn("slotpip", busy && "slotpip--busy", real && !busy && "slotpip--free")}
              disabled={disabled || target.slotsLocked}
              aria-label={
                target.slotsLocked
                  ? `${target.label}: provider-managed slot ${i + 1}`
                  : real
                  ? `Slot ${i + 1}${device ? ` on GPU ${device}` : ""}${busy ? ", busy" : ", free"}`
                  : `Add a ${i + 1}${i === 0 ? "st" : i === 1 ? "nd" : i === 2 ? "rd" : "th"} slot`
              }
              title={
                target.slotsLocked
                  ? target.slotLockReason || "This slot count is managed by the provider"
                  : real
                  ? `Slot ${i + 1}${device ? ` → GPU ${device}` : ""}`
                  : `Run ${i + 1} jobs at once here`
              }
              onClick={() => onSetSlots?.(i + 1)}
            >
              {device !== undefined && <span className="slotpip-dev num">{device}</span>}
            </button>
          );
        })}
      </div>
      {devices.length > 0 && (
        <span className="slot-devices num" title="One GPU pinned per slot">
          <Cpu size={10} aria-hidden /> {devices.join(" ")}
        </span>
      )}
      {shared && (
        <span
          className="slot-warn"
          title={
            `${slots} solves will share this GPU's VRAM. A mesh that fits alone can fail ` +
            `alongside another — pin one device per slot, or drop back to 1.`
          }
        >
          <AlertTriangle size={11} aria-hidden /> shared VRAM
        </span>
      )}
    </div>
  );
}
