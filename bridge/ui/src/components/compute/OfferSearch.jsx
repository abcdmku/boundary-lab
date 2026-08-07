import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Checkbox, Field, NumberInput, TextInput } from "../ui/field.jsx";
import { RentDialog } from "./RentDialog.jsx";
import { apiCall, json } from "../../lib/api";
import { fmtNum, fmtRate } from "../../lib/format";
import { cn } from "../../lib/cn";
import "./compute.css";

const COLUMNS = [
  { key: "gpuName", label: "GPU", sort: "gpuName" },
  { key: "numGpus", label: "n", sort: "numGpus", num: true },
  { key: "gpuRamGb", label: "VRAM", sort: "gpuRamGb", num: true },
  { key: "pricePerHour", label: "$/hr", sort: "pricePerHour", num: true },
  { key: "dlperfPerDollar", label: "dlperf/$", sort: "dlperfPerDollar", num: true },
  { key: "reliability", label: "rel.", sort: "reliability", num: true },
  { key: "cudaMaxGood", label: "CUDA", sort: "cudaMaxGood", num: true },
  { key: "inetDownMbps", label: "down", sort: "inetDownMbps", num: true },
  { key: "geolocation", label: "region", sort: "geolocation" },
];

const EMPTY = {
  gpuName: "",
  minGpuRamGb: undefined,
  numGpus: undefined,
  maxPricePerHour: undefined,
  minReliability: undefined,
  minDiskGb: undefined,
  minCudaVersion: undefined,
  minInetDownMbps: undefined,
  region: "",
  verified: true,
  limit: 40,
};

/**
 * Search rentable GPUs and rent one.
 *
 * Read-only until the explicit Rent button, which opens the two-phase
 * confirmation. Sorting is client-side over the returned page so re-sorting
 * never spends one of vast's 10 searches/minute.
 */
export function OfferSearch({ status, onRented, notify }) {
  const [filters, setFilters] = useState(EMPTY);
  const [offers, setOffers] = useState(null);
  const [query, setQuery] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState({ key: "pricePerHour", dir: "asc" });
  const [renting, setRenting] = useState(null);

  const set = (key) => (v) => setFilters((f) => ({ ...f, [key]: v }));

  const search = async () => {
    setLoading(true);
    setError(null);
    const body = {
      ...(filters.gpuName.trim()
        ? { gpuName: filters.gpuName.split(",").map((s) => s.trim()).filter(Boolean) }
        : {}),
      ...(filters.region.trim()
        ? { region: filters.region.split(",").map((s) => s.trim()).filter(Boolean) }
        : {}),
      ...(filters.minGpuRamGb !== undefined ? { minGpuRamGb: filters.minGpuRamGb } : {}),
      ...(filters.numGpus !== undefined ? { numGpus: filters.numGpus } : {}),
      ...(filters.maxPricePerHour !== undefined
        ? { maxPricePerHour: filters.maxPricePerHour }
        : {}),
      ...(filters.minReliability !== undefined ? { minReliability: filters.minReliability } : {}),
      ...(filters.minDiskGb !== undefined ? { minDiskGb: filters.minDiskGb } : {}),
      ...(filters.minCudaVersion !== undefined ? { minCudaVersion: filters.minCudaVersion } : {}),
      ...(filters.minInetDownMbps !== undefined
        ? { minInetDownMbps: filters.minInetDownMbps }
        : {}),
      verified: filters.verified,
      limit: filters.limit,
    };
    const res = await apiCall("/api/vast/offers/search", json("POST", body));
    setLoading(false);
    if (res.ok) {
      setOffers(res.data.offers || []);
      setQuery(res.data.query || null);
    } else {
      setOffers(null);
      setError(res.data.error || `search failed (${res.status})`);
    }
  };

  const sorted = useMemo(() => {
    if (!offers) return null;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...offers].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return (typeof av === "string" ? av.localeCompare(bv) : av - bv) * dir;
    });
  }, [offers, sort]);

  const toggleSort = (key) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));

  const ceiling = status?.limits?.maxPricePerHour ?? 2;

  return (
    <div>
      <div className="offer-filters">
        <Field label="GPU name" hint="comma separated">
          <TextInput
            value={filters.gpuName}
            onChange={(e) => set("gpuName")(e.target.value)}
            placeholder="RTX 4090, A100"
          />
        </Field>
        <Field label="min VRAM (GB)">
          <NumberInput value={filters.minGpuRamGb} onValue={set("minGpuRamGb")} placeholder="24" />
        </Field>
        <Field label="GPUs">
          <NumberInput value={filters.numGpus} onValue={set("numGpus")} placeholder="1" />
        </Field>
        <Field label="max $/hr" hint={`bridge ceiling ${ceiling}`}>
          <NumberInput
            value={filters.maxPricePerHour}
            onValue={set("maxPricePerHour")}
            step={0.05}
            placeholder={String(ceiling)}
          />
        </Field>
        <Field label="min reliability" hint="0–1">
          <NumberInput
            value={filters.minReliability}
            onValue={set("minReliability")}
            step={0.01}
            min={0}
            max={1}
            placeholder="0.98"
          />
        </Field>
        <Field label="min disk (GB)">
          <NumberInput value={filters.minDiskGb} onValue={set("minDiskGb")} placeholder="60" />
        </Field>
        <Field label="min CUDA">
          <NumberInput
            value={filters.minCudaVersion}
            onValue={set("minCudaVersion")}
            step={0.1}
            placeholder="12.4"
          />
        </Field>
        <Field label="min down (Mbps)">
          <NumberInput
            value={filters.minInetDownMbps}
            onValue={set("minInetDownMbps")}
            placeholder="200"
          />
        </Field>
        <Field label="region" hint="comma separated">
          <TextInput
            value={filters.region}
            onChange={(e) => set("region")(e.target.value)}
            placeholder="US, EU"
          />
        </Field>
        <Field label="limit">
          <NumberInput value={filters.limit} onValue={set("limit")} min={1} max={200} />
        </Field>
        <div style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 2 }}>
          <Checkbox
            label="verified only"
            checked={filters.verified}
            onChange={(e) => set("verified")(e.target.checked)}
          />
        </div>
        <div style={{ display: "flex", gap: 6, paddingBottom: 2 }}>
          <button type="button" className="btn btn--primary" onClick={search} disabled={loading}>
            <Search size={12} aria-hidden /> {loading ? "Searching…" : "Search"}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setFilters(EMPTY);
              setOffers(null);
              setError(null);
            }}
          >
            Reset
          </button>
        </div>
      </div>

      {error && <div className="notice notice--warn" style={{ marginTop: 10 }}>{error}</div>}

      {loading && (
        <div className="panel-empty">
          <span className="spinner" /> Searching vast.ai…
        </div>
      )}

      {!loading && sorted && sorted.length === 0 && (
        <div className="panel-empty">
          No offer matches these filters. Loosen the price ceiling, VRAM or reliability and search
          again.
        </div>
      )}

      {!loading && sorted && sorted.length > 0 && (
        <>
          <div className="panel-note" style={{ margin: "10px 0 6px" }}>
            {sorted.length} offer{sorted.length === 1 ? "" : "s"} · sorted by {sort.key} (
            {sort.dir}) · click a column to re-sort
            {query && (
              <>
                {" "}
                · <span className="mono">{JSON.stringify(query).slice(0, 160)}</span>
              </>
            )}
          </div>
          <div className="dtable-scroll">
            <table className="dtable">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      className={cn("sortable", c.num && "num")}
                      onClick={() => toggleSort(c.sort)}
                      aria-sort={
                        sort.key === c.sort
                          ? sort.dir === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      {c.label}
                      {sort.key === c.sort && (
                        <span className="sort-caret">{sort.dir === "asc" ? "▲" : "▼"}</span>
                      )}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.map((o) => {
                  const overCeiling = o.pricePerHour > ceiling;
                  return (
                    <tr key={o.id}>
                      <td title={`offer ${o.id} · machine ${o.machineId}`}>{o.gpuName}</td>
                      <td className="num">{o.numGpus}</td>
                      <td className="num">{fmtNum(o.gpuRamGb, 0)}</td>
                      <td className="num offer-price">{fmtNum(o.pricePerHour, 3)}</td>
                      <td className="num dtable-muted">{fmtNum(o.dlperfPerDollar, 1)}</td>
                      <td className="num dtable-muted">
                        {o.reliability === null ? "—" : fmtNum(o.reliability * 100, 1)}
                      </td>
                      <td className="num dtable-muted">{o.cudaMaxGood ?? "—"}</td>
                      <td className="num dtable-muted">{fmtNum(o.inetDownMbps, 0)}</td>
                      <td className="dtable-muted">{o.geolocation || "—"}</td>
                      <td className="num">
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={overCeiling || !o.rentable || o.rented}
                          onClick={() => setRenting(o)}
                          title={
                            overCeiling
                              ? `${fmtRate(o.pricePerHour)} is above this bridge's ${ceiling}/hr ceiling`
                              : !o.rentable || o.rented
                                ? "This offer is no longer rentable"
                                : "Review the price, then confirm"
                          }
                        >
                          Rent…
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {renting && (
        <RentDialog
          offer={renting}
          defaults={status?.defaults}
          maxPricePerHour={ceiling}
          notify={notify}
          onDone={onRented}
          onClose={() => setRenting(null)}
        />
      )}
    </div>
  );
}
