import { useMemo, useState } from "react";
import { Modal } from "../ui/modal.jsx";
import { Field, TextInput } from "../ui/field.jsx";
import { TargetPicker } from "../forms/TargetPicker.jsx";
import { SolveSettings, validateSolveSettings } from "../forms/SolveSettings.jsx";
import { json } from "../../lib/api";
import { fmtInt } from "../../lib/format";

/**
 * One solve on one mesh. The batch dialog covers "many solves on many meshes";
 * this is the single-shot path, and the place a target is first chosen.
 */
export function SolveDialog({ mesh, targets, api, refetch, onClose }) {
  const [name, setName] = useState("");
  const [settings, setSettings] = useState({});
  const [targetId, setTargetId] = useState("local");
  const [busy, setBusy] = useState(null);

  const errors = useMemo(() => validateSolveSettings(settings), [settings]);
  const invalid = Object.keys(errors).length > 0;
  const target = (targets || []).find((t) => t.id === targetId);
  const targetBad = targetId !== "local" && target && !target.available;
  const meshReady = mesh.status === "done";

  const submit = async (mode) => {
    if (invalid || targetBad) return;
    setBusy(mode);
    try {
      const body = {
        meshJobId: mesh.id,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...settings,
        target: targetId,
      };
      if (mode === "draft") await api("/api/jobs", json("POST", { kind: "solve", ...body }));
      else await api("/api/solve", json("POST", body));
      refetch();
      onClose();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  };

  const tris = mesh.summary && mesh.summary.triangles;

  return (
    <Modal
      title={`Solve “${mesh.name}”`}
      subtitle={[
        `mesh ${mesh.id}`,
        tris !== undefined ? `${fmtInt(tris)} triangles` : null,
        `status ${mesh.status}`,
      ]
        .filter(Boolean)
        .join(" · ")}
      onClose={onClose}
      footer={
        <>
          <span className="modal-foot-spacer" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={invalid || targetBad || busy !== null}
            onClick={() => submit("draft")}
            title="Create it as a draft — nothing runs until you launch it"
          >
            {busy === "draft" ? "Saving…" : "Save draft"}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={invalid || targetBad || !meshReady || busy !== null}
            onClick={() => submit("now")}
            title={meshReady ? undefined : `the mesh is ${mesh.status} — it must finish first`}
          >
            {busy === "now" ? "Queueing…" : "Launch now"}
          </button>
        </>
      }
    >
      <div className="field-stack">
        {!meshReady && (
          <div className="notice notice--warn">
            This mesh is <b>{mesh.status}</b>. You can still stage a draft now — launching is
            refused until the mesh finishes.
          </div>
        )}
        <Field label="job name" hint={`optional — defaults to “solve ${mesh.name}”`}>
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`solve ${mesh.name}`}
          />
        </Field>
        <TargetPicker
          targets={targets}
          value={targetId}
          onChange={setTargetId}
          hint="Local runs one solve at a time; a remote instance gets its own lane."
        />
        <SolveSettings
          value={settings}
          onChange={setSettings}
          errors={errors}
          remote={targetId !== "local"}
        />
      </div>
    </Modal>
  );
}
