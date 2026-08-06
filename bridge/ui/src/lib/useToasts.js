import { useCallback, useState } from "react";

let seq = 0;

export function useToasts() {
  const [toasts, setToasts] = useState([]);

  const notify = useCallback((msg) => {
    const id = ++seq;
    setToasts((prev) => [...prev, { id, msg }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  return { toasts, notify };
}
