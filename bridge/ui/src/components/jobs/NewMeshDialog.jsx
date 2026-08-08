import { useMemo, useState } from "react";
import { Modal } from "../ui/modal.jsx";
import { Field, Select, TextInput } from "../ui/field.jsx";
import { SchemaForm, validateParams } from "../forms/SchemaForm.jsx";
import { paramDelta } from "../../lib/board";
import { json } from "../../lib/api";

/**
 * Create a mesh job from a generator's schema — or derive one from an
 * existing mesh.
 *
 * Passing `variantOf` switches it into VARIANT mode: the generator is fixed to
 * the parent's, the parent's params are the starting point, and only what you
 * change is sent. That is what an optimization step actually is, and going
 * through this path is what makes the result render as part of the parent's
 * lineage instead of an unrelated twenty-first mesh.
 *
 * Two exits, because they mean different things: "Save draft" parks a
 * configured-but-unstarted job on the schedule board's backlog, while
 * "Generate now" is the one-step path. Meshing always runs on the bridge host,
 * so there is no target picker here.
 */
export function NewMeshDialog({
  generators,
  initialGeneratorId,
  initialProjectId,
  variantOf,
  projects,
  api,
  refetch,
  onClose,
  onCreated,
}) {
  const list = generators || [];
  const isVariant = !!variantOf;
  const [generatorId, setGeneratorId] = useState(
    () => variantOf?.generator || initialGeneratorId || (list[0] ? list[0].id : ""),
  );
  const [name, setName] = useState("");
  // In variant mode the parent's params ARE the form's starting values, so the
  // form shows the geometry as it stands and every edit is visible as a delta.
  const [params, setParams] = useState(() => ({ ...(variantOf?.params || {}) }));
  const [projectId, setProjectId] = useState(
    () => variantOf?.projectId || initialProjectId || "",
  );
  const [busy, setBusy] = useState(null);

  const generator = list.find((g) => g.id === generatorId);
  const schema = generator?.params;
  const errors = useMemo(() => validateParams(schema, params), [schema, params]);
  const invalid = Object.keys(errors).length > 0;
  const delta = useMemo(
    () => (isVariant ? paramDelta(variantOf.params, params) : []),
    [isVariant, variantOf, params],
  );

  const submit = async (mode) => {
    if (invalid) return;
    setBusy(mode);
    try {
      let created;
      if (isVariant) {
        // Only the delta travels: the server merges it over the parent's
        // params, so a parameter the parent later gains is not silently pinned
        // to whatever this form happened to show.
        created = await api(
          `/api/jobs/${variantOf.id}/variant`,
          json("POST", {
            params: Object.fromEntries(delta),
            ...(name.trim() ? { name: name.trim() } : {}),
            ...(projectId ? { project: projectId } : {}),
            launch: mode === "now",
          }),
        );
      } else {
        const body = {
          generator: generatorId,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(projectId ? { project: projectId } : {}),
          params,
        };
        created =
          mode === "draft"
            ? await api("/api/jobs", json("POST", { kind: "mesh", ...body }))
            : await api("/api/generate", json("POST", body));
      }
      refetch();
      onCreated?.(created);
      onClose();
    } catch {
      /* apiRequest toasted it */
    } finally {
      setBusy(null);
    }
  };

  const overridden = Object.keys(params).length;
  const total = Object.keys(schema?.properties || {}).length;

  return (
    <Modal
      title={isVariant ? "New variant" : "New mesh job"}
      subtitle={
        isVariant
          ? `Derived from “${variantOf.name || variantOf.id}” — only what you change is applied.`
          : "Parameters come from the generator's own schema. Blank fields use its defaults."
      }
      onClose={onClose}
      size="wide"
      footer={
        <>
          <span className="panel-note">
            {isVariant
              ? delta.length === 0
                ? "Nothing changed yet"
                : `${delta.length} parameter${delta.length === 1 ? "" : "s"} changed: ${delta
                    .slice(0, 3)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(", ")}${delta.length > 3 ? "…" : ""}`
              : generator
                ? `${overridden} of ${total} parameters overridden`
                : ""}
          </span>
          <span className="modal-foot-spacer" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={!generatorId || invalid || busy !== null || (isVariant && delta.length === 0)}
            onClick={() => submit("draft")}
          >
            {busy === "draft" ? "Saving…" : "Save draft"}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!generatorId || invalid || busy !== null || (isVariant && delta.length === 0)}
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
          <div className="field-row field-row--3">
            <Field label="generator">
              <Select
                value={generatorId}
                disabled={isVariant}
                onChange={(e) => {
                  setGeneratorId(e.target.value);
                  setParams({});
                }}
              >
                {list.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title || g.id}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="job name" hint={isVariant ? "optional — defaults to what changed" : "optional"}>
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={isVariant ? `${variantOf.name} · …` : `${generatorId} mesh`}
              />
            </Field>
            <Field label="design" hint="groups this mesh with its variants and solves">
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {(!isVariant || !variantOf?.projectId) && (
                  <option value="">unassigned</option>
                )}
                {(projects || []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {generator?.description && !isVariant && (
            <div className="panel-note">{generator.description}</div>
          )}
          <SchemaForm schema={schema} values={params} onChange={setParams} errors={errors} />
        </div>
      )}
    </Modal>
  );
}
