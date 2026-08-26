import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "./api";
import type { Insights } from "./types";

const REFRESH_MS = 60000;

export function useInsights() {
  const [insights, setInsights] = useState<Insights | null>(null);

  const refresh = useCallback(async () => {
    const next = await api<Insights>("/api/insights").catch(() => null);
    if (next) setInsights(next);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { insights, refresh };
}
