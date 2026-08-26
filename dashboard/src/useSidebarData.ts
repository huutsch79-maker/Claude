import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "./api";
import type { Capability, HealthReport, Proposal, ScriptDef, ScriptRun } from "./types";

const REFRESH_MS = 30000;

export function useSidebarData() {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [scripts, setScripts] = useState<ScriptDef[]>([]);
  const [scriptRuns, setScriptRuns] = useState<ScriptRun[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);

  const refresh = useCallback(async () => {
    const [healthRes, proposalsRes, scriptsRes, runsRes, capsRes] = await Promise.all([
      api<HealthReport>("/api/health").catch(() => null),
      api<Proposal[]>("/api/proposals?status=pending").catch(() => []),
      api<ScriptDef[]>("/api/scripts").catch(() => []),
      api<ScriptRun[]>("/api/script-runs").catch(() => []),
      api<Capability[]>("/api/capabilities").catch(() => []),
    ]);
    setHealth(healthRes);
    setProposals(proposalsRes);
    setScripts(scriptsRes);
    setScriptRuns(runsRes);
    setCapabilities(capsRes);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { health, proposals, scripts, scriptRuns, capabilities, refresh };
}
