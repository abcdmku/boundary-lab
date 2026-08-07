import { useEffect, useMemo, useState } from "react";
import { Field, Select, TextInput } from "../ui/field.jsx";
import { TargetPicker } from "../forms/TargetPicker.jsx";
import { SchemaForm, ParamsReadout, validateParams } from "../forms/SchemaForm.jsx";
import { SolveSettings, SolveSettingsReadout, validateSolveSettings } from "../forms/SolveSettings.jsx";
import { json } from "../../lib/api";
import { jobTargetId, jobTargetLabel, targetSummary } from "../../lib/targets";

const SOLVE_KEYS = ["fmin", "fmax", "count", "backend", "symmetry"];

const solveSettingsOf = (job) => {
  const out = {};
  for (const k of SOLVE_KEYS) if (job.params?.[k] !== undefined) out[k] = job.params[k];
  return out;
};

/**
 * A job's configuration, in the row it belongs to.
 *
 * Drafts are editable and PATCH themselves; anything else is read-only,
 * because PATCH /api/jobs/:id answers 409 for a non-draft. Showing an editable
 * form that always fails would be a lie, so a launched job says plainly that
 * its settings are locked and offers the only real alternative — clone it into
 * a fresh draft.
 */
export function ConfigTab({ job, jobs, generators, targets, api, refetch, onOpenSolve }) {
  const isDraft = job.status === "draft";
  const generator = (generators || []).find((g) => g.id === job.generator);
  const schema = generator?.params;

  const [name, setName] = useState(job.name || "");
  const [params, setParams] = useState(() => ({ ...(job.params || {}) }));
  const [settings, setSettings] = useState(() => solveSettingsOf(job));
  const [targetId, setTargetId] = useState(() => jobTargetId(job));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // A concurrent edit (MCP tool, another tab) arrives over SSE — re-seed the
  // form rather than silently holding a stale draft the user would then save.
  useEffect(() => {
    setName(job.name || "");
    setParams({ ...(job.params || {}) });
    setSettings(solveSettingsOf(job));
    setTargetId(jobTargetId(job));
    setSaved(false);
  }, [job.id, job.updatedAt, job.status]);

  const errors = useMemo(
    () => (job.kind === "mesh" ? validateParams(schema, params) : validateSolveSettings(settings)),
    [job.kind, schema, params, settings],
  );
  const invalid = Object.keys(errors).length > 0;

  const dirty =
    name !== (job.name || "") ||
    targetId !== jobTargetId(job) ||
    (job.kind === "mesh"
      ? JSON.stringify(params) !== JSON.stringify(job.params || {})
      : JSON.stringify(settings) !== JSON.stringify(solveSettingsOf(job)));

  const save = async () => {
    if (invalid) return;
    setSaving(true);
    try {
      const body =
        job.kind === "mesh"
          ? { name, params }
          : { name, options: settings, target: targetId };
      await api(`/api/jobs/${job.id}`, json("PATCH", body));
      refetch();
      setSaved(true);
    } catch {
      /* toasted — 409 here means it stopped being a draft under us */
    } finally {
      setSaving(false);
    }
  };

  const launch = async () => {
    setSaving(true);
    try {
      if (dirty) {
        const body =
          job.kind === "mesh" ? { name, params } : { name, options: settings, target: targetId };
        await api(`/api/jobs/${job.id}`, json("PATCH", body));
      }
      const res = await api(`/api/jobs/${job.id}/launch`, { method: "POST" });
      refetch();
      // launchJobs reports refusals instead of throwing — surface them.
      const skipped = res?.skipped?.[0];
      if (skipped) throw new Error(skipped.reason);
    } catch {
      /* toasted */
    } finally {
      setSaving(false);
    }
  };

  // ---------- read-only: launched jobs ----------
  if (!isDraft) {
    const mesh = job.kind === "solve" ? (jobs || []).find((j) => j.id === job.parentJobId) : null;
    return (
      <div className="field-stack">
        <div className="notice">
          Settings are locked once a job is launched — the bridge answers 409 to an edit of a{" "}
          <b>{job.status}</b> job.
          {job.kind === "solve" && mesh && mesh.status === "done" && (
            <>
              {" "}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => onOpenSolve?.(mesh)}
              >
                Solve this mesh again →
              </button>
            </>
          )}
        </div>
        <div className="field-row field-row--2">
          <div>
            <div className="sweep-legend">{job.kind === "mesh" ? "Parameters" : "Solve settings"}</div>
            {job.kind === "mesh" ? (
              <ParamsReadout params={job.params} />
            ) : (
              <SolveSettingsReadout params={job.params} />
            )}
          </div>
          <div>
            <div className="sweep-legend">Execution</div>
            <dl className="kv">
              <dt>target</dt>
              <dd>{jobTargetLabel(job, targets)}</dd>
              {job.target?.serverUrl && (
                <>
                  <dt>server</dt>
                  <dd className="mono">{job.target.serverUrl}</dd>
                </>
              )}
              {job.generator && (
                <>
                  <dt>generator</dt>
                  <dd>{job.generator}</dd>
                </>
              )}
              {job.batchId && (
                <>
                  <dt>batch</dt>
                  <dd>{job.batchName || job.batchId}</dd>
                </>
              )}
              <dt>created</dt>
              <dd>{new Date(job.createdAt).toLocaleString()}</dd>
              {job.launchedAt && (
                <>
                  <dt>launched</dt>
                  <dd>{new Date(job.launchedAt).toLocaleString()}</dd>
                </>
              )}
              {job.finishedAt && (
                <>
                  <dt>finished</dt>
                  <dd>{new Date(job.finishedAt).toLocaleString()}</dd>
                </>
              )}
            </dl>
          </div>
        </div>
      </div>
    );
  }

  // ---------- editable: drafts ----------
  const mesh = job.kind === "solve" ? (jobs || []).find((j) => j.id === job.parentJobId) : null;
  const target = (targets || []).find((t) => t.id === targetId);

  return (
    <div className="field-stack">
      <div className="field-row field-row--2">
        <Field label="job name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {job.kind === "solve" ? (
          <Field label="mesh" hint="the mesh this solve reads">
            <Select value={job.parentJobId || ""} disabled>
              <option value={job.parentJobId || ""}>
                {mesh ? `${mesh.name} — ${mesh.status}` : job.parentJobId}
              </option>
            </Select>
          </Field>
        ) : (
          <Field label="generator" hint="meshing always runs on the bridge host">
            <Select value={job.generator || ""} disabled>
              <option value={job.generator || ""}>{generator?.title || job.generator}</option>
            </Select>
          </Field>
        )}
      </div>

      {job.kind === "solve" ? (
        <>
          <TargetPicker targets={targets} value={targetId} onChange={setTargetId} />
          <SolveSettings
            value={settings}
            onChange={setSettings}
            errors={errors}
            remote={targetId !== "local"}
          />
        </>
      ) : (
        <SchemaForm schema={schema} values={params} onChange={setParams} errors={errors} />
      )}

      {job.kind === "solve" && mesh && mesh.status !== "done" && (
        <div className="notice notice--warn">
          The mesh “{mesh.name}” is {mesh.status}. Launching is refused until it is done.
        </div>
      )}

      <div className="btn-group">
        <button type="button" className="btn" onClick={save} disabled={!dirty || invalid || saving}>
          {saving ? "Saving…" : dirty ? "Save changes" : saved ? "Saved" : "No changes"}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={launch}
          disabled={invalid || saving}
          title={
            target && !target.available
              ? target.unavailableReason
              : "Save any edits and queue this job"
          }
        >
          {dirty ? "Save & launch" : "Launch"}
        </button>
        {target && (
          <span className="panel-note">
            → {target.label} · {targetSummary(target)}
          </span>
        )}
      </div>
    </div>
  );
}
