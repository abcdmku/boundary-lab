import { useCallback, useEffect, useRef, useState } from "react";

export async function apiRequest(path, opts, onError) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    onError?.("Network error: " + e.message);
    throw e;
  }
  if (!res.ok) {
    let msg = res.status + " " + res.statusText;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch {
      /* not json */
    }
    onError?.(msg);
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : null;
}

/**
 * Non-throwing sibling of apiRequest for the calls whose FAILURE body is the
 * point: /api/vast/* answers a money-moving request without `confirm` with
 * 402 + a full price quote, and 403/409 carry the ceiling and the stale-offer
 * reason. A toast that ate those would make renting undebuggable.
 *
 * Always resolves to { ok, status, data } — data is the parsed JSON body
 * ({ error } on failure), or {} when there was none.
 */
export async function apiCall(path, opts) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    return { ok: false, status: 0, data: { error: "Network error: " + e.message } };
  }
  let data = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) {
    try {
      data = await res.json();
    } catch {
      /* empty or malformed body */
    }
  }
  return { ok: res.ok, status: res.status, data: data ?? {} };
}

/** Request init for a JSON POST/PATCH — express.json() needs the content type. */
export const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

// GET /api/state once, then keep it fresh: SSE (/api/events) is a "something
// changed" signal only — any message (named or default) triggers a debounced
// refetch of the full state, same as the previous vanilla implementation.
export function useBridgeState(onError) {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(false);
  const refetchTimer = useRef(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const fetchState = async () => {
    try {
      const data = await apiRequest("/api/state", undefined, onErrorRef.current);
      setState(data);
    } catch {
      /* apiRequest already reported it */
    }
  };

  useEffect(() => {
    fetchState();
    const es = new EventSource("/api/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const scheduleRefetch = () => {
      clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(fetchState, 250);
    };
    es.onmessage = scheduleRefetch;
    for (const name of ["job", "state", "ping"]) es.addEventListener(name, scheduleRefetch);
    return () => {
      es.close();
      clearTimeout(refetchTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, connected, refetch: fetchState };
}

/**
 * One-shot GET with loading/error/empty state, for the surfaces that are NOT
 * in the SSE snapshot (vast provider config). `deps` re-runs it; `reload()`
 * refetches on demand.
 */
export function useFetch(path, { enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!enabled || !path) return;
    const mine = ++seq.current;
    setLoading(true);
    const res = await apiCall(path);
    if (mine !== seq.current) return; // a newer request won
    setLoading(false);
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else {
      setError(res.data.error || `request failed (${res.status})`);
    }
  }, [path, enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}
