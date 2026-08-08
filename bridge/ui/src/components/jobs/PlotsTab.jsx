// Responsive thumbnail grid of white-framed tiles (the matplotlib PNGs are
// white with baked-in titles, so no captions). A broken image hides its
// whole tile.
export function PlotsTab({ job, onOpenLightbox }) {
  const images = (job.artifacts || []).filter((a) => a.kind === "plot");
  if (!images.length) {
    return <div className="job-tab-empty">No plots yet</div>;
  }
  return (
    <div className="plot-grid">
      {images.map((a) => (
        <button
          key={a.url}
          type="button"
          className="plot-open"
          onClick={() => onOpenLightbox(a.url, a.name)}
          aria-label={`Open ${a.name}`}
        >
          <img
            src={a.url}
            alt={a.name}
            loading="lazy"
            onError={(e) => {
              const tile = e.currentTarget.closest("button");
              if (tile) tile.style.display = "none";
            }}
            className="plot-thumb"
          />
        </button>
      ))}
    </div>
  );
}
