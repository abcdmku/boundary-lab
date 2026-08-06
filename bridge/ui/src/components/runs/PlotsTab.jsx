// Responsive thumbnail grid of white-framed tiles (the matplotlib PNGs are
// white with baked-in titles, so no captions). A broken image hides its
// whole tile.
export function PlotsTab({ run, onOpenLightbox }) {
  const images = (run.artifacts || []).filter((a) => a.kind === "plot");
  if (!images.length) {
    return <div className="run-tab-empty">No plots yet</div>;
  }
  return (
    <div className="plot-grid">
      {images.map((a) => (
        <img
          key={a.url}
          src={a.url}
          alt={a.name}
          loading="lazy"
          onClick={() => onOpenLightbox(a.url)}
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
          className="plot-thumb"
        />
      ))}
    </div>
  );
}
