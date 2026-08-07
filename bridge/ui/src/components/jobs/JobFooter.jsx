import { fmtScore } from "../../lib/format";

// Fixed display order for the metrics.json subscores.
const SUBSCORE_LABELS = [
  ["coverage", "coverage"],
  ["di_smoothness", "DI"],
  ["on_axis_ripple", "ripple"],
  ["size", "size"],
];

function ScoreLine({ summary }) {
  const subs = summary && summary.subscores;
  if (!subs || typeof subs !== "object" || Array.isArray(subs)) return null;
  // A null subscore means the scorer could not measure that term (see
  // metrics.json `warnings`); it was dropped from the weighted score rather
  // than awarded 1.0. Show it as n/a — omitting it entirely would hide that
  // the job is being scored on fewer terms than the spec asked for.
  const parts = SUBSCORE_LABELS.filter(([key]) => key in subs).map(([key, label]) =>
    typeof subs[key] === "number" && Number.isFinite(subs[key])
      ? `${label} ${fmtScore(subs[key])}`
      : `${label} n/a`,
  );
  if (!parts.length) return null;
  const score = summary.score;
  const head =
    typeof score === "number" && Number.isFinite(score) ? `score ${fmtScore(score)} — ` : "";
  return <div className="job-footer-scores">{head + parts.join(" · ")}</div>;
}

// Quiet footer: subscore breakdown (when metrics exist) + at most three small
// download links — mesh (the *_clean.msh, or first .msh), config, log — plus
// the error text for failed jobs.
// Nothing else; the full artifact list is the AI's business over MCP.
export function JobFooter({ job }) {
  const arts = job.artifacts || [];
  const nameOf = (a) => (a.name || "").toLowerCase();
  const mesh =
    arts.find((a) => nameOf(a).endsWith("_clean.msh")) ||
    arts.find((a) => nameOf(a).endsWith(".msh"));
  const config = arts.find((a) => a.kind === "config");
  const log = arts.find((a) => a.kind === "log");
  const links = [
    mesh && { label: "mesh", ...mesh },
    config && { label: "config", ...config },
    log && { label: "log", ...log },
  ].filter(Boolean);

  const showError = job.status === "failed" && job.error;
  const scoreLine = ScoreLine({ summary: job.summary });
  if (!links.length && !showError && !scoreLine) return null;

  return (
    <div className="job-footer">
      {scoreLine}
      {links.length > 0 && (
        <div>
          {links.map((a, i) => (
            <span key={a.url}>
              {i > 0 && <span className="job-footer-sep">·</span>}
              <a href={a.url} target="_blank" rel="noreferrer" title={a.name}>
                {a.label}
              </a>
            </span>
          ))}
        </div>
      )}
      {showError && <div className="job-footer-error">{job.error}</div>}
    </div>
  );
}
