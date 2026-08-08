import { Modal } from "../ui/modal.jsx";
import { VastPanel } from "./VastPanel.jsx";
import { fmtRate } from "../../lib/format";
import { billingCount } from "../../lib/vast";
import "./compute.css";

/**
 * Getting a machine — the one part of the old Compute view that the schedule
 * board does not already say.
 *
 * The board answers "what are my machines doing": every target is a column,
 * with its slots, its queue and its reason for being unusable. It cannot
 * answer "give me another one", because renting spends real money and needs a
 * search, a price ceiling and an explicit confirmation. That lives here,
 * reached from the board's own "+ machine" column, so the answer to "where did
 * Compute go" is "it is the thing you press to add a column".
 *
 * The burn line is repeated at the top on purpose: this is the surface where
 * an instance gets destroyed, and the cost of NOT destroying one belongs in
 * view at that moment.
 */
export function MachinesDialog({ state, refetch, notify, onClose }) {
  const vast = state?.vast;
  const burn = vast?.activeBurnRatePerHour ?? 0;

  return (
    <Modal
      title="Machines"
      subtitle="Rent, adopt and release remote GPUs. Each one becomes a column on the board."
      onClose={onClose}
      size="xwide"
      footer={
        <>
          {burn > 0 ? (
            <span className="panel-note">
              <b style={{ color: "var(--destructive-foreground)" }}>{fmtRate(burn)}</b> billing
              across {billingCount(vast?.instances)} instance
              {billingCount(vast?.instances) === 1 ? "" : "s"} — only <b>Destroy</b> ends charges.
            </span>
          ) : (
            <span className="panel-note">Nothing is billing.</span>
          )}
          <span className="modal-foot-spacer" />
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <VastPanel
        vast={vast}
        targets={state?.targets || []}
        refetch={refetch}
        notify={notify}
      />
    </Modal>
  );
}
