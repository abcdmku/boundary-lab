import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Loader2 } from "lucide-react";
import { Modal } from "../ui/modal.jsx";
import { Select, TextInput } from "../ui/field.jsx";
import { validateParams } from "../forms/SchemaForm.jsx";
import { ParamRail } from "./ParamRail.jsx";
import { MeshViewer } from "./MeshViewer.jsx";
import { apiCall, json } from "../../lib/api";
import { paramDelta } from "../../lib/board";
import { fmtBytes, fmtInt } from "../../lib/format";
import "./meshEditor.css";

/**
 * Pacing of the live loop, in ms. DEBOUNCE lets a burst of edits settle;
 * MAX_STALE caps how long the viewport may disagree with the form, because a
 * slider being dragged emits an event every few ms and would otherwise reset
 * the debounce forever — showing you the mesh only once you let go, which is
 * the one moment you no longer need it.
 */
const DEBOUNCE_MS = 90;
const MAX_STALE_MS = 200;

/** Scratch-directory name for this editor's previews; server-side shape is [A-Za-z0-9_-]{1,64}. */
function newSessionId() {
  const random = globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);
  return "ed-" + random.replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
}

function bboxLabel(bbox) {
  if (!Array.isArray(bbox) || bbox.length < 3) return "—";
  return bbox.map((v) => Math.round(v)).join(" × ") + " mm";
}

function Stat({ label, value, title }) {
  return (
    <div className="mesh-stat" title={title}>
      <span className="mesh-stat__label">{label}</span>
      <span className="mesh-stat__value">{value}</span>
    </div>
  );
}

/**
 * Live mesh editor: the generator's parameters on the left, the geometry they
 * produce on the right, re-rendered as you type or drag.
 *
 * This replaces the old fire-and-inspect dialog, where the only way to see a
 * mesh was to run a job and open its Mesh tab. The loop behind it is
 * POST /api/preview (see bridge/src/preview.ts) — a warm python worker outside
 * the job queue, ~0.2 s per render — so nothing reaches the ledger until you
 * actually ask for it.
 *
 * Passing `variantOf` switches it into VARIANT mode: the generator is fixed to
 * the parent's, the parent's params are the starting point, and only what you
 * change is sent. That is what an optimization step actually is, and going
 * through this path is what makes the result render as part of the parent's
 * lineage instead of an unrelated twenty-first mesh. The live preview is worth
 * more here than anywhere else — a variant is defined by a handful of edits,
 * and this is the first time you can see what they do before spending a job.
 *
 * Two exits, because they mean different things: "Save draft" parks a
 * configured-but-unstarted job on the schedule board's backlog, while
 * "Generate now" is the one-step path. Meshing always runs on the bridge host,
 * so there is no target picker.
 */
export function MeshEditor({
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
  // viewport opens on the parent's geometry and every edit is visible both as a
  // delta and as a change in the mesh.
  const [params, setParams] = useState(() => ({ ...(variantOf?.params || {}) }));
  const [projectId, setProjectId] = useState(() => variantOf?.projectId || initialProjectId || "");
  const [busy, setBusy] = useState(null);

  const [preview, setPreview] = useState(null);
  const [rendering, setRendering] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [fitKey, setFitKey] = useState(0);

  const sessionId = useRef(newSessionId()).current;
  const abortRef = useRef(null);
  const inFlight = useRef(false);
  /** The parameter set the viewport is showing or fetching; null forces a render. */
  const shownKey = useRef(null);
  /** When the viewport first went stale with the loop idle; 0 when it is not. */
  const staleSince = useRef(0);
  /** Bumped when a render settles, so the dispatch effect reconsiders. */
  const [settled, setSettled] = useState(0);

  const generator = list.find((g) => g.id === generatorId);
  const schema = generator?.params;
  const errors = useMemo(() => validateParams(schema, params), [schema, params]);
  const invalid = Object.keys(errors).length > 0;
  const delta = useMemo(
    () => (isVariant ? paramDelta(variantOf.params, params) : []),
    [isVariant, variantOf, params],
  );
  // A variant with no edits is not a variant. The preview still renders it, so
  // you can look at the parent before deciding what to change.
  const nothingToSubmit = isVariant && delta.length === 0;

  // JSON, not the object identity: SchemaForm rebuilds `params` on every
  // keystroke, and re-rendering identical geometry is the one thing this loop
  // must not do. The generator is part of the key because switching to one
  // whose defaults are all unset would otherwise look like no change at all.
  const renderKey = `${generatorId} ${JSON.stringify(params)}`;

  const render = useCallback(async () => {
    inFlight.current = true;
    shownKey.current = renderKey;
    staleSince.current = 0;
    const controller = new AbortController();
    abortRef.current = controller;
    setRendering(true);

    const res = await apiCall("/api/preview", {
      ...json("POST", { sessionId, generator: generatorId, params }),
      signal: controller.signal,
    });

    inFlight.current = false;
    if (controller.signal.aborted) return; // the editor closed
    setRendering(false);
    if (!res.ok) {
      // 422 is the generator rejecting these parameters — a normal thing to see
      // halfway through typing. Keep the last good mesh on screen and say why.
      setPreviewError(res.data.error || `preview failed (${res.status})`);
    } else if (res.data.superseded) {
      shownKey.current = null; // never drawn, so it does not count as shown
    } else {
      setPreviewError(null);
      setPreview(res.data);
    }
    setSettled((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, generatorId, renderKey]);

  // The live loop: at most one render outstanding, and whatever the parameters
  // say when it lands is what gets rendered next.
  //
  // The tempting shape — debounce, and abort the previous request on every
  // edit — is wrong here, and measurably so. Aborting the HTTP request does
  // not stop the mesh being built; the work still completes, it just arrives
  // at a closed socket. Dragging a slider that way discards every frame it
  // paid for and the viewport only catches up once you let go. Waiting instead
  // means a sustained drag repaints every render-time (~0.2-0.5 s) with the
  // newest values, and a burst of typing still collapses to a single render.
  //
  // Invalid input never leaves the browser — the schema bounds are the same
  // ones the generator would raise on.
  useEffect(() => {
    if (!generatorId || invalid) return undefined;
    if (inFlight.current || renderKey === shownKey.current) {
      staleSince.current = 0;
      return undefined;
    }
    if (!staleSince.current) staleSince.current = Date.now();
    // Each edit pushes the render out by DEBOUNCE, but never past the point
    // where the viewport has been wrong for MAX_STALE.
    const waited = Date.now() - staleSince.current;
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_STALE_MS - waited));
    const timer = setTimeout(render, delay);
    return () => clearTimeout(timer);
  }, [generatorId, invalid, renderKey, settled, render]);

  // Editors are closed, not unmounted cleanly, more often than anyone admits;
  // the bridge sweeps stale sessions on its own, and this is the fast path.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      void fetch(`/api/preview/${sessionId}`, { method: "DELETE", keepalive: true }).catch(() => {});
    };
  }, [sessionId]);

  const submit = async (mode) => {
    if (invalid || nothingToSubmit) return;
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

  return (
    <Modal
      title={isVariant ? "Mesh editor — new variant" : "Mesh editor"}
      subtitle={
        isVariant
          ? `Derived from “${variantOf.name || variantOf.id}” — only what you change is applied.`
          : "Geometry re-renders as you edit. Nothing reaches the ledger until you save or generate."
      }
      onClose={onClose}
      size="full"
      footer={
        <>
          <Select
            className="mesh-editor__generator"
            value={generatorId}
            aria-label="generator"
            // A variant is the same design as its parent; changing the
            // generator would make it a different object, not a variant.
            disabled={isVariant}
            onChange={(e) => {
              setGeneratorId(e.target.value);
              setParams({});
              // A different generator is a different object; re-frame it.
              setPreview(null);
              setFitKey(0);
            }}
          >
            {list.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title || g.id}
              </option>
            ))}
          </Select>
          <TextInput
            className="mesh-editor__name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isVariant ? `${variantOf.name} · …` : `${generatorId} mesh`}
            aria-label="job name"
            title={
              isVariant
                ? "Job name — optional, defaults to what changed"
                : "Job name — optional, defaults to “<generator> mesh”"
            }
          />
          <Select
            className="mesh-editor__design"
            value={projectId}
            aria-label="design"
            title="Design — groups this mesh with its variants and solves"
            onChange={(e) => setProjectId(e.target.value)}
          >
            {(!isVariant || !variantOf?.projectId) && <option value="">unassigned</option>}
            {(projects || []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          {isVariant && (
            <span className="panel-note mesh-editor__delta">
              {delta.length === 0
                ? "Nothing changed yet"
                : `${delta.length} changed: ${delta
                    .slice(0, 3)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(", ")}${delta.length > 3 ? "…" : ""}`}
            </span>
          )}
          <span className="modal-foot-spacer" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={!generatorId || invalid || busy !== null || nothingToSubmit}
            onClick={() => submit("draft")}
          >
            {busy === "draft" ? "Saving…" : "Save draft"}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!generatorId || invalid || busy !== null || nothingToSubmit}
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
        <div className="mesh-editor">
          <div className="mesh-editor__params">
            <ParamRail schema={schema} values={params} onChange={setParams} errors={errors} />
          </div>

          {/* The viewport IS the surface: everything else floats over it, so
              nothing but the mesh claims layout space. */}
          <div className="mesh-editor__stage">
            {/* Keyed by generator so switching horns starts a fresh scene
                rather than deforming one shape into another. */}
            <MeshViewer
              key={generatorId}
              wallsUrl={preview?.wallsUrl}
              drivenUrl={preview?.drivenUrl}
              fitKey={fitKey}
            />
            {!preview && !previewError && (
              <div className="mesh-editor__overlay">
                {invalid ? "Fix the highlighted parameters to render" : "Rendering…"}
              </div>
            )}
            {rendering && preview && (
              <div className="mesh-editor__pill">
                <Loader2 size={11} aria-hidden /> rendering
              </div>
            )}
            <button
              type="button"
              className="btn btn--ghost btn--sm mesh-editor__fit"
              onClick={() => setFitKey((k) => k + 1)}
              disabled={!preview}
              title="Re-frame the camera on the current mesh"
            >
              <Crosshair size={12} aria-hidden /> Fit
            </button>

            <div className="mesh-editor__stats">
              <Stat label="tris" value={preview ? fmtInt(preview.triangles) : "—"} />
              <Stat label="size" value={bboxLabel(preview?.bboxMm)} />
              <Stat
                label="vram"
                value={preview ? fmtBytes(preview.vramBytes) : "—"}
                title="Estimated peak GPU memory for a symmetry-off solve of this mesh"
              />
              <Stat
                label="render"
                value={preview ? `${Math.round(preview.elapsedMs)} ms` : "—"}
                title="Time the preview worker spent building this geometry"
              />
            </div>

            {(previewError || preview?.qualityWarning) && (
              <div className="mesh-editor__alert">
                {previewError || `Mesh quality: ${preview.qualityWarning}`}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
