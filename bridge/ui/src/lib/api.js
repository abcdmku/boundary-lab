import { useEffect, useRef, useState } from "react";

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
    for (const name of ["run", "state", "ping"]) es.addEventListener(name, scheduleRefetch);
    return () => {
      es.close();
      clearTimeout(refetchTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, connected, refetch: fetchState };
}
