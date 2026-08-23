import type { CapabilityContext, CapabilityModule } from "../../../domain/capabilityRegistry.js";

export interface NzbRequest {
  intent: "m365.mail.search" | "dynamics.record.lookup";
  payload: Record<string, unknown>;
}

/**
 * Work-domain dynamic module: NZB's M365/Dynamics BC connector. The one
 * real work-domain connector recommended to build first (see CLAUDE.md).
 * Structurally near-identical to the personal Hotmail module — that's
 * intentional, it's the same dynamic-module pattern applied to a
 * different domain's own credential/tenant, never sharing either.
 */
const nzbConnectorModule: CapabilityModule = {
  canHandle(request: unknown): boolean {
    const req = request as Partial<NzbRequest>;
    return req?.intent === "m365.mail.search" || req?.intent === "dynamics.record.lookup";
  },

  async handle(request: unknown, ctx: CapabilityContext): Promise<unknown> {
    const req = request as NzbRequest;
    if (!ctx.credential) {
      throw new Error(
        "nzb-m365-connector: no credential configured. Set JARVIS_WORK_NZB_M365_OAUTH " +
          "(NZB tenant app registration) before using this capability.",
      );
    }

    if (req.intent === "m365.mail.search") {
      const query = typeof req.payload.query === "string" ? req.payload.query : "";
      const response = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages?$search="${encodeURIComponent(query)}"`,
        { headers: { authorization: `Bearer ${ctx.credential.value}` } },
      );
      if (!response.ok) throw new Error(`nzb-m365-connector: Graph search failed (${response.status})`);
      return response.json();
    }

    // dynamics.record.lookup
    const dynamicsBase = process.env.JARVIS_WORK_DYNAMICS_BASE_URL ?? "https://api.businesscentral.dynamics.com/v2.0";
    const recordId = String(req.payload.id ?? "");
    const response = await fetch(`${dynamicsBase}/records/${encodeURIComponent(recordId)}`, {
      headers: { authorization: `Bearer ${ctx.credential.value}` },
    });
    if (!response.ok) throw new Error(`nzb-m365-connector: Dynamics lookup failed (${response.status})`);
    return response.json();
  },
};

export default nzbConnectorModule;
