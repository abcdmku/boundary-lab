import { useMemo, useState } from "react";
import { Plus, Copy, X } from "lucide-react";
import { Modal } from "../ui/modal.jsx";
import { Field, NumberInput, Select, TextInput } from "../ui/field.jsx";
import { TargetPicker } from "../forms/TargetPicker.jsx";
import { SolveSettings, BACKENDS, SYMMETRIES, validateSolveSettings } from "../forms/SolveSettings.jsx";
import { SchemaForm, validateParams } from "../forms/SchemaForm.jsx";
import { StatusDot } from "./StatusDot.jsx";
import {
  MAX_BATCH_JOBS,
  coerceSweepValue,
  paramsSummary,
  parseParamPairs,
  previewJobs,
  settingsSummary,
} from "./batchPreview";
import { json } from "../../lib/api";
import { fmtInt } from "../../lib/format";
import "./batch.css";

let variantSeq = 0;
const newVariant = (init = {}) => ({
  key: ++variantSeq,
  name: "",
  settings: {},
  params: {},
  // Raw text of the mesh param editor lives on the variant, not inside the
  // row: a parse error has to reach the dialog's blockers, or the buttons stay
  // enabled while `params` silently holds the last text that DID parse.
  paramsText: "",
  paramsError: null,
  targetId: "",
  ...init,
});

const SOLVE_SWEEP_FIELDS = [
  ["fmin", "fmin (Hz)"],
  ["fmax", "fmax (Hz)"],
  ["count", "points"],
  ["backend", "backend"],
  ["symmetry", "symmetry"],
  ["target", "target"],
];

/**
 * The sweep builder: N meshes × M variants, previewed with its exact job count
 * before anything is created.
 *
 * Two rules drive the design:
 *   - the cross product is the product, so the count is the headline number
 *     and the resulting job list is visible BEFORE the request goes out;
 *   - the server validates all-or-nothing (a rejected sweep creates nothing),
 *     so everything checkable client-side is checked here and the `skipped[]`
 *     the server reports back is shown verbatim, per job, with its reason.
 */
export function BatchDialog({
  kind: initialKind,
  jobs,
  generators,
  targets,
  projects,
  initialMeshIds,
  initialGeneratorId,
  api,
  refetch,
  onClose,
}) {
  const [kind, setKind] = useState(initialKind || "solve");
  const [batchName, setBatchName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [meshIds, setMeshIds] = useState(() => new Set(initialMeshIds || []));
  const [meshQuery, setMeshQuery] = useState("");
  const [baseSettings, setBaseSettings] = useState({});
  const [generatorId, setGeneratorId] = useState(
    () => initialGeneratorId || (generators && generators[0]?.id) || "",
  );
  const [baseParams, setBaseParams] = useState({});
  const [defaultTargetId, setDefaultTargetId] = useState("local");
  const [variants, setVariants] = useState(() => [newVariant()]);
  const [sweepField, setSweepField] = useState("count");
  const [sweepValues, setSweepValues] = useState("");
  const [sweepError, setSweepError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);

  const meshJobs = useMemo(() => (jobs || []).filter((j) => j.kind === "mesh"), [jobs]);
  const generator = (generators || []).find((g) => g.id === generatorId);
  const schema = generator?.params;

  const selectedMeshes = useMemo(
    () => meshJobs.filter((m) => meshIds.has(m.id)),
    [meshJobs, meshIds],
  );

  const rows = useMemo(
    () =>
      previewJobs({
        kind,
        batchName,
        meshes: selectedMeshes,
        generatorId,
        variants,
        defaultTargetId,
      }),
    [kind, batchName, selectedMeshes, generatorId, variants, defaultTargetId],
  );

  // ---- validation -----------------------------------------------------
  const baseErrors =
    kind === "solve" ? validateSolveSettings(baseSettings) : validateParams(schema, baseParams);
  // A variant is validated as the job it will BECOME — base merged with the
  // override — so a variant that pushes a schema-bounded param out of range is
  // caught here rather than by a mesh job that fails an hour later.
  const variantErrors = variants.map((v) =>
    kind === "solve"
      ? validateSolveSettings({ ...baseSettings, ...v.settings })
      : validateParams(schema, { ...baseParams, ...v.params }),
  );
  const hasFieldErrors =
    Object.keys(baseErrors).length > 0 || variantErrors.some((e) => Object.keys(e).length > 0);
  const unparsedVariants = variants.filter((v) => v.paramsError);

  const targetById = (id) => (targets || []).find((t) => t.id === id);
  const usedTargetIds = [...new Set(rows.map((r) => r.targetId || "local"))];
  const badTargets = usedTargetIds
    .map(targetById)
    .filter((t) => t && !t.available);

  const total = rows.length;
  const overCap = total > MAX_BATCH_JOBS;
  const notDone = selectedMeshes.filter((m) => m.status !== "done");

  const blockers = [];
  if (kind === "solve" && selectedMeshes.length === 0) blockers.push("Select at least one mesh.");
  if (kind === "mesh" && !generatorId) blockers.push("Pick a generator.");
  if (total === 0) blockers.push("This configuration would create no jobs.");
  if (overCap)
    blockers.push(
      `${fmtInt(total)} jobs is over the ${MAX_BATCH_JOBS}-job cap — the bridge will refuse the whole sweep.`,
    );
  if (hasFieldErrors) blockers.push("Fix the highlighted settings.");
  if (unparsedVariants.length)
    blockers.push(
      `Variant ${variants.indexOf(unparsedVariants[0]) + 1}: ${unparsedVariants[0].paramsError}`,
    );
  for (const t of badTargets)
    blockers.push(
      `${t.label} cannot take work: ${t.unavailableReason || t.status || "unavailable"}`,
    );

  // Which fields the quick-sweep can vary. For a mesh batch that is the
  // generator's schema, so the selection has to survive a generator change.
  const sweepFields =
    kind === "solve"
      ? SOLVE_SWEEP_FIELDS
      : Object.keys((schema && schema.properties) || {}).map((n) => [n, n]);
  const activeSweepField = sweepFields.some(([id]) => id === sweepField)
    ? sweepField
    : (sweepFields[0]?.[0] ?? "");

  // ---- variant editing ------------------------------------------------
  const patchVariant = (key, patch) =>
    setVariants((prev) => prev.map((v) => (v.key === key ? { ...v, ...patch } : v)));
  const dropVariant = (key) =>
    setVariants((prev) => (prev.length === 1 ? [newVariant()] : prev.filter((v) => v.key !== key)));

  const addSweep = () => {
    const pieces = sweepValues
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!pieces.length) {
      setSweepError("Enter one or more comma-separated values.");
      return;
    }
    const made = [];
    for (const piece of pieces) {
      const value = coerceSweepValue(activeSweepField, piece, schema);
      if (value === null) {
        setSweepError(`“${piece}” is not a valid ${activeSweepField} value.`);
        return;
      }
      if (kind === "solve")
        made.push(
          activeSweepField === "target"
            ? newVariant({ targetId: String(value) })
            : newVariant({ settings: { [activeSweepField]: value } }),
        );
      else
        made.push(
          newVariant({
            params: { [activeSweepField]: value },
            paramsText: `${activeSweepField}=${value}`,
          }),
        );
    }
    setSweepError(null);
    setSweepValues("");
    // A single untouched variant is the "no sweep yet" placeholder — replace it
    // rather than multiplying it, which is what a user expects on first use.
    setVariants((prev) => {
      const pristine =
        prev.length === 1 &&
        !prev[0].name &&
        !prev[0].targetId &&
        Object.keys(prev[0].settings).length === 0 &&
        Object.keys(prev[0].params).length === 0 &&
        !prev[0].paramsText;
      return pristine ? made : [...prev, ...made];
    });
  };

  // ---- submit ---------------------------------------------------------
  const submit = async (launch) => {
    if (blockers.length) return;
    setBusy(launch ? "launch" : "draft");
    try {
      const body =
        kind === "solve"
          ? {
              kind: "solve",
              ...(batchName.trim() ? { name: batchName.trim() } : {}),
              meshJobIds: [...selectedMeshes.map((m) => m.id)],
              options: baseSettings,
              target: defaultTargetId,
              launch,
              variants: variants.map((v) => ({
                ...(v.name.trim() ? { name: v.name.trim() } : {}),
                ...v.settings,
                ...(v.targetId ? { target: v.targetId } : {}),
              })),
            }
          : {
              kind: "mesh",
              ...(batchName.trim() ? { name: batchName.trim() } : {}),
              ...(projectId ? { project: projectId } : {}),
              generator: generatorId,
              params: baseParams,
              launch,
              variants: variants.map((v) => ({
                ...(v.name.trim() ? { name: v.name.trim() } : {}),
                params: v.params,
              })),
            };
      const res = await api("/api/jobs/batch", json("POST", body));
      refetch();
      setResult(res);
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  };

  // ---- result view ----------------------------------------------------
  if (result) {
    const skipped = result.skipped || [];
    const jobsById = new Map((result.jobs || []).map((j) => [j.id, j]));
    return (
      <Modal
        title="Batch created"
        subtitle={`${result.batchName || result.batchId} · ${result.created} job${result.created === 1 ? "" : "s"}`}
        onClose={onClose}
        size="wide"
        footer={
          <>
            <span className="modal-foot-spacer" />
            <button type="button" className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          </>
        }
      >
        <div className="field-stack">
          <div className="stat-row" style={{ border: "1px solid var(--border)", borderRadius: 10 }}>
            <div className="stat">
              <div className="stat-label">Created</div>
              <div className="stat-value">{result.created}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Launched</div>
              <div className="stat-value">{(result.launched || []).length}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Skipped</div>
              <div className={"stat-value" + (skipped.length ? " stat-value--cost" : " stat-value--muted")}>
                {skipped.length}
              </div>
            </div>
          </div>
          {skipped.length > 0 && (
            <div>
              <div className="sweep-legend">Skipped, and why</div>
              <div className="result-list">
                {skipped.map((s) => (
                  <div key={s.jobId} className="result-row">
                    <span className="result-id">{jobsById.get(s.jobId)?.name || s.jobId}</span>
                    <span style={{ color: "var(--destructive-foreground)" }}>{s.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {skipped.length === 0 && (
            <div className="panel-note">
              Every job was created{(result.launched || []).length ? " and queued" : " as a draft"}.
            </div>
          )}
        </div>
      </Modal>
    );
  }

  // ---- builder view ---------------------------------------------------
  return (
    <Modal
      title={kind === "solve" ? "Batch solves" : "Batch meshes"}
      subtitle={
        kind === "solve"
          ? "One job per mesh per variant. Nothing is created until you say so."
          : "One mesh job per variant, from the generator's schema."
      }
      onClose={onClose}
      size="xwide"
      footer={
        <>
          <div className="preview-head" style={{ marginBottom: 0 }}>
            <span className={"preview-count" + (overCap ? " preview-count--over" : "")}>
              {fmtInt(total)}
            </span>
            <span className="preview-formula">
              {kind === "solve"
                ? `${selectedMeshes.length} mesh${selectedMeshes.length === 1 ? "" : "es"} × ${variants.length} variant${variants.length === 1 ? "" : "s"}`
                : `${variants.length} variant${variants.length === 1 ? "" : "s"}`}
              {" job"}
              {total === 1 ? "" : "s"}
            </span>
          </div>
          <span className="modal-foot-spacer" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={blockers.length > 0 || busy !== null}
            onClick={() => submit(false)}
            title="Create every job as a draft — edit or launch them later"
          >
            {busy === "draft" ? "Creating…" : "Create drafts"}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={blockers.length > 0 || busy !== null}
            onClick={() => submit(true)}
          >
            {busy === "launch" ? "Launching…" : `Create & launch ${fmtInt(total)}`}
          </button>
        </>
      }
    >
      <div className="field-stack">
        <div className={`field-row ${kind === "solve" ? "field-row--3" : "field-row--4"}`}>
          <Field label="kind">
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setVariants([newVariant()]);
                setSweepField(e.target.value === "solve" ? "count" : sweepFields[0]?.[0] || "");
              }}
            >
              <option value="solve">solve — sweep settings over meshes</option>
              <option value="mesh">mesh — sweep generator params</option>
            </Select>
          </Field>
          <Field label="batch name" hint="optional — names every job in the batch">
            <TextInput
              value={batchName}
              onChange={(e) => setBatchName(e.target.value)}
              placeholder={kind === "solve" ? "e.g. cd90x60 sweep" : `${generatorId} sweep`}
            />
          </Field>
          {kind === "mesh" && (
            <Field label="design" hint="blank = a design named after the batch">
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">new, from the name</option>
                {(projects || []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {kind === "solve" ? (
            <TargetPicker
              targets={targets}
              value={defaultTargetId}
              onChange={setDefaultTargetId}
              label="default target"
              hint="each variant may override this"
            />
          ) : (
            <Field label="generator">
              <Select
                value={generatorId}
                onChange={(e) => {
                  setGeneratorId(e.target.value);
                  setBaseParams({});
                  setVariants([newVariant()]);
                }}
              >
                {(generators || []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title || g.id}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        <div className="sweep-grid">
          {/* ---------------- sources ---------------- */}
          <div className="sweep-col">
            {kind === "solve" ? (
              <div className="sweep-section">
                <div className="sweep-legend">
                  Meshes ({selectedMeshes.length}/{meshJobs.length})
                  <span className="sweep-legend-actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() =>
                        setMeshIds(new Set(meshJobs.filter((m) => m.status === "done").map((m) => m.id)))
                      }
                    >
                      All done
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setMeshIds(new Set())}
                      disabled={meshIds.size === 0}
                    >
                      Clear
                    </button>
                  </span>
                </div>
                <TextInput
                  value={meshQuery}
                  onChange={(e) => setMeshQuery(e.target.value)}
                  placeholder="Filter meshes…"
                  aria-label="Filter meshes"
                  style={{ marginBottom: 6 }}
                />
                <div className="mesh-list" role="group" aria-label="Meshes to solve">
                  {meshJobs.length === 0 && (
                    <div className="panel-empty">No mesh jobs yet — generate one first.</div>
                  )}
                  {meshJobs
                    .filter((m) =>
                      meshQuery.trim()
                        ? (m.name || m.id).toLowerCase().includes(meshQuery.trim().toLowerCase())
                        : true,
                    )
                    .map((m) => {
                      const on = meshIds.has(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          className={"mesh-item" + (on ? " mesh-item--on" : "")}
                          onClick={() =>
                            setMeshIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(m.id)) next.delete(m.id);
                              else next.add(m.id);
                              return next;
                            })
                          }
                        >
                          {/* purely the tick mark — the button carries the
                              checkbox role, so this must not be announced or
                              focused as a second control */}
                          <input type="checkbox" readOnly checked={on} tabIndex={-1} aria-hidden />
                          <StatusDot status={m.status} />
                          <span className="mesh-item-name">{m.name || m.id}</span>
                          <span className="mesh-item-meta">
                            {m.summary && m.summary.triangles !== undefined
                              ? `${fmtInt(m.summary.triangles)} tris`
                              : m.status}
                          </span>
                        </button>
                      );
                    })}
                </div>
                {notDone.length > 0 && (
                  <div className="notice notice--warn" style={{ marginTop: 6 }}>
                    {notDone.length} selected mesh{notDone.length === 1 ? " is" : "es are"} not done.
                    Drafts are fine; “Create &amp; launch” will skip their solves with a reason.
                  </div>
                )}
              </div>
            ) : null}

            <div className="sweep-section">
              <div className="sweep-legend">Base settings — every variant starts here</div>
              {kind === "solve" ? (
                <SolveSettings
                  value={baseSettings}
                  onChange={setBaseSettings}
                  errors={baseErrors}
                  remote={defaultTargetId !== "local"}
                />
              ) : (
                <SchemaForm
                  schema={schema}
                  values={baseParams}
                  onChange={setBaseParams}
                  errors={baseErrors}
                />
              )}
            </div>
          </div>

          {/* ---------------- variants + preview ---------------- */}
          <div className="sweep-col">
            <div className="sweep-section">
              <div className="sweep-legend">
                Variants
                <span className="sweep-legend-actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setVariants((prev) => [...prev, newVariant()])}
                  >
                    <Plus size={12} aria-hidden /> Add
                  </button>
                </span>
              </div>

              {/* quick sweep: one field, comma-separated values, one variant each */}
              <div
                className="field-row"
                style={{ gridTemplateColumns: "minmax(110px,150px) 1fr max-content", alignItems: "end" }}
              >
                <Field label="quick sweep">
                  <Select value={activeSweepField} onChange={(e) => setSweepField(e.target.value)}>
                    {sweepFields.map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="values (comma separated)">
                  <TextInput
                    value={sweepValues}
                    onChange={(e) => setSweepValues(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addSweep();
                      }
                    }}
                    placeholder={
                      activeSweepField === "target"
                        ? (targets || []).map((t) => t.id).join(", ")
                        : activeSweepField === "symmetry"
                          ? "off, x, xy"
                          : "24, 48, 96"
                    }
                  />
                </Field>
                <button type="button" className="btn" onClick={addSweep}>
                  Add variants
                </button>
              </div>
              {sweepError && <div className="field-error">{sweepError}</div>}

              <div style={{ marginTop: 8, overflowX: "auto" }}>
                <table className="variant-table">
                  <thead>
                    <tr>
                      <th className="variant-index" />
                      <th style={{ width: "18%" }}>name</th>
                      {kind === "solve" ? (
                        <>
                          <th style={{ width: "11%" }}>fmin</th>
                          <th style={{ width: "11%" }}>fmax</th>
                          <th style={{ width: "9%" }}>pts</th>
                          <th style={{ width: "15%" }}>backend</th>
                          <th style={{ width: "12%" }}>symmetry</th>
                          <th style={{ width: "18%" }}>target</th>
                        </>
                      ) : (
                        <th>param overrides (key=value, …)</th>
                      )}
                      <th className="variant-drop" />
                    </tr>
                  </thead>
                  <tbody>
                    {variants.map((v, i) => (
                      <VariantRow
                        key={v.key}
                        index={i}
                        variant={v}
                        kind={kind}
                        schema={schema}
                        targets={targets}
                        errors={variantErrors[i]}
                        onPatch={(patch) => patchVariant(v.key, patch)}
                        onDuplicate={() =>
                          setVariants((prev) => {
                            const copy = newVariant({
                              name: v.name,
                              settings: { ...v.settings },
                              params: { ...v.params },
                              paramsText: v.paramsText,
                              paramsError: v.paramsError,
                              targetId: v.targetId,
                            });
                            const at = prev.findIndex((x) => x.key === v.key);
                            return [...prev.slice(0, at + 1), copy, ...prev.slice(at + 1)];
                          })
                        }
                        onDrop={() => dropVariant(v.key)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="sweep-section">
              <div className="sweep-legend">Preview — exactly what will be created</div>
              {total === 0 ? (
                <div className="panel-empty" style={{ border: "1px solid var(--border)", borderRadius: 10 }}>
                  {kind === "solve" ? "Select a mesh to see the sweep." : "Add a variant."}
                </div>
              ) : (
                <div className="preview-scroll">
                  <table className="dtable">
                    <thead>
                      <tr>
                        <th>job name</th>
                        {kind === "solve" && <th>mesh</th>}
                        <th>{kind === "solve" ? "settings delta" : "param overrides"}</th>
                        <th>target</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, MAX_BATCH_JOBS).map((r) => (
                        <tr key={r.key}>
                          <td className="preview-name">{r.name}</td>
                          {kind === "solve" && <td className="dtable-muted">{r.mesh?.name}</td>}
                          <td className="dtable-muted">
                            {kind === "solve" ? settingsSummary(r.settings) : paramsSummary(r.params)}
                          </td>
                          <td className="dtable-muted">{r.targetId}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {total > MAX_BATCH_JOBS && (
                    <div className="panel-error">
                      Showing the first {MAX_BATCH_JOBS}. The bridge refuses more than{" "}
                      {MAX_BATCH_JOBS} jobs in one batch.
                    </div>
                  )}
                </div>
              )}
            </div>

            {blockers.length > 0 && (
              <div className="notice notice--warn">
                {blockers.map((b) => (
                  <div key={b}>{b}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function VariantRow({ index, variant, kind, schema, targets, errors, onPatch, onDuplicate, onDrop }) {
  const setSetting = (key) => (value) =>
    onPatch({
      settings: (() => {
        const next = { ...variant.settings };
        if (value === undefined || value === "") delete next[key];
        else next[key] = value;
        return next;
      })(),
    });

  return (
    <tr>
      <td className="variant-index">{index + 1}</td>
      <td>
        <TextInput
          value={variant.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="auto"
          aria-label={`variant ${index + 1} name`}
        />
      </td>
      {kind === "solve" ? (
        <>
          <td>
            <NumberInput
              value={variant.settings.fmin}
              onValue={setSetting("fmin")}
              placeholder="base"
              invalid={!!errors?.fmin}
              aria-label={`variant ${index + 1} fmin`}
            />
          </td>
          <td>
            <NumberInput
              value={variant.settings.fmax}
              onValue={setSetting("fmax")}
              placeholder="base"
              invalid={!!errors?.fmax}
              aria-label={`variant ${index + 1} fmax`}
            />
          </td>
          <td>
            <NumberInput
              value={variant.settings.count}
              onValue={setSetting("count")}
              placeholder="base"
              invalid={!!errors?.count}
              aria-label={`variant ${index + 1} points`}
            />
          </td>
          <td>
            <Select
              value={variant.settings.backend ?? ""}
              onChange={(e) => setSetting("backend")(e.target.value || undefined)}
              aria-label={`variant ${index + 1} backend`}
            >
              <option value="">base</option>
              {BACKENDS.map(([id]) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </Select>
          </td>
          <td>
            <Select
              value={variant.settings.symmetry ?? ""}
              onChange={(e) => setSetting("symmetry")(e.target.value || undefined)}
              aria-label={`variant ${index + 1} symmetry`}
            >
              <option value="">base</option>
              {SYMMETRIES.map(([id]) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </Select>
          </td>
          <td>
            <Select
              value={variant.targetId}
              onChange={(e) => onPatch({ targetId: e.target.value })}
              aria-label={`variant ${index + 1} target`}
            >
              <option value="">default</option>
              {(targets || []).map((t) => (
                <option key={t.id} value={t.id} disabled={!t.available}>
                  {t.id}
                  {t.available ? "" : " (unavailable)"}
                </option>
              ))}
            </Select>
          </td>
        </>
      ) : (
        <td>
          <TextInput
            value={variant.paramsText}
            invalid={!!variant.paramsError || Object.keys(errors || {}).length > 0}
            onChange={(e) => {
              const text = e.target.value;
              const { params, error } = parseParamPairs(text, schema);
              // Keep the text and the error together with the params they came
              // from: on a parse error `params` is left alone, and the stored
              // error is what stops the batch from being created.
              onPatch(error ? { paramsText: text, paramsError: error } : { paramsText: text, paramsError: null, params });
            }}
            placeholder="length=120, mouth_width=260"
            aria-label={`variant ${index + 1} params`}
          />
          {variant.paramsError ? (
            <div className="field-error">{variant.paramsError}</div>
          ) : (
            Object.entries(errors || {}).map(([k, msg]) => (
              <div key={k} className="field-error">{`${k}: ${msg}`}</div>
            ))
          )}
        </td>
      )}
      <td className="variant-drop">
        <div style={{ display: "flex" }}>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onDuplicate}
            title="Duplicate this variant"
            aria-label={`duplicate variant ${index + 1}`}
          >
            <Copy size={11} aria-hidden />
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onDrop}
            title="Remove this variant"
            aria-label={`remove variant ${index + 1}`}
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      </td>
    </tr>
  );
}
