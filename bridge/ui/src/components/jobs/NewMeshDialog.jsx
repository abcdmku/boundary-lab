import { useMemo, useState } from "react";
import { Modal } from "../ui/modal.jsx";
import { Field, Select, TextInput } from "../ui/field.jsx";
import { SchemaForm, validateParams } from "../forms/SchemaForm.jsx";
import { json } from "../../lib/api";

/**
 * Create a mesh job from a generator's schema.
 *
 * Two exits, because they mean different things: "Save draft" parks a
 * configured-but-unstarted job on the board (the point of drafts — you can
 * stage ten meshes before running any), while "Generate now" is the old
 * one-step path. Meshing always runs on the bridge host, so there is no target
 * picker here.
 */
export function NewMeshDialog({ generators, initialGeneratorId, api, refetch, onClose, onCreated }) {
  const list = generators || [];
  const [generatorId, setGeneratorId] = useState(
    initialGeneratorId || (list[0] ? list[0].id : ""),
  );
  const [name, setName] = useState("");
  const [params, setParams] = useState({});
  const [busy, setBusy] = useState(null);

  const generator = list.find((g) => g.id === generatorId);
  const schema = generator?.params;
  const errors = useMemo(() => validateParams(schema, params), [schema, params]);
  const invalid = Object.keys(errors).length > 0;

  const submit = async (mode) => {
    if (invalid) return;
    setBusy(mode);
    try {
      const body = {
        generator: generatorId,
        ...(name.trim() ? { name: name.trim() } : {}),
        params,
      };
      const created =
        mode === "draft"
          ? await api("/api/jobs", json("POST", { kind: "mesh", ...body }))
          : await api("/api/generate", json("POST", body));
      refetch();
      onCreated?.(created);
      onClose();
    } catch {
      /* apiRequest toasted it */
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title="New mesh job"
      subtitle="Parameters come from the generator's own schema. Blank fields use its defaults."
      onClose={onClose}
      size="wide"
      footer={
        <>
          <span className="panel-note">
            {generator ? `${Object.keys(params).length} of ${Object.keys(schema?.properties || {}).length} parameters overridden` : ""}
          </span>
          <span className="modal-foot-spacer" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={!generatorId || invalid || busy !== null}
            onClick={() => submit("draft")}
          >
            {busy === "draft" ? "Saving…" : "Save draft"}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!generatorId || invalid || busy !== null}
            onClick={() => submit("now")}
          >
            {busy === "now" ? "Starting…" : "Generate now"}
          </button>
        </>
      }
    >
      {!list.length ? (
        <div className="notice notice--warn">
          No generators are available. The python layer may not be built — try Refresh in the
          generators rail.
        </div>
      ) : (
        <div className="field-stack">
          <div className="field-row field-row--2">
            <Field label="generator">
              <Select value={generatorId} onChange={(e) => { setGeneratorId(e.target.value); setParams({}); }}>
                {list.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title || g.id}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="job name" hint="optional — defaults to “<generator> mesh”">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`${generatorId} mesh`}
              />
            </Field>
          </div>
          {generator?.description && <div className="panel-note">{generator.description}</div>}
          <SchemaForm schema={schema} values={params} onChange={setParams} errors={errors} />
        </div>
      )}
    </Modal>
  );
}
