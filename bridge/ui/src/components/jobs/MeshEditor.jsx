import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Loader2 } from "lucide-react";
import { Modal } from "../ui/modal.jsx";
import { Select, TextInput } from "../ui/field.jsx";
import { validateParams } from "../forms/SchemaForm.jsx";
import { ParamRail } from "./ParamRail.jsx";
import { MeshViewer } from "./MeshViewer.jsx";
import { apiCall, json } from "../../lib/api";
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
 * the job queue, ~0.2 s per render — so nothing here creates a board row until
 * you actually ask for one.
 *
 * Two exits, unchanged from the dialog it replaces, because they still mean
 * different things: "Save draft" parks a configured-but-unstarted job on the
 * board (stage ten meshes before running any), "Generate now" runs it. Meshing
 * always runs on the bridge host, so there is no target picker.
 */
export function MeshEditor({ generators, initialGeneratorId, api, refetch, onClose, onCreated }) {
  const list = generators || [];
  const [generatorId, setGeneratorId] = useState(
    initialGeneratorId || (list[0] ? list[0].id : ""),
  );
  const [name, setName] = useState("");
  const [params, setParams] = useState({});
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
      title="Mesh editor"
      subtitle="Geometry re-renders as you edit. Nothing reaches the board until you save or generate."
      onClose={onClose}
      size="full"
      footer={
        <>
          <Select
            className="mesh-editor__generator"
            value={generatorId}
            aria-label="generator"
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
            placeholder={`${generatorId} mesh`}
            aria-label="job name"
            title="Job name — optional, defaults to “<generator> mesh”"
          />
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
