import type { CapabilityContext, CapabilityModule } from "../../domain/capabilityRegistry.js";
import { describeFailedResponse } from "../../domain/httpError.js";

export interface NzbRequest {
  intent: "m365.mail.search" | "m365.mail.unreadCount" | "dynamics.record.lookup";
  payload: Record<string, unknown>;
}

/**
 * NZB's M365/Dynamics BC connector. One of the two starter connectors,
 * alongside the Hotmail module — structurally near-identical, applying
 * the same dynamic-module pattern to a different tenant/credential.
 */
const nzbConnectorModule: CapabilityModule = {
  canHandle(request: unknown): boolean {
    const req = request as Partial<NzbRequest>;
    return req?.intent === "m365.mail.search" || req?.intent === "m365.mail.unreadCount" || req?.intent === "dynamics.record.lookup";
  },

  async handle(request: unknown, ctx: CapabilityContext): Promise<unknown> {
    const req = request as NzbRequest;
    if (!ctx.credential) {
      throw new Error(
        "nzb-m365-connector: no credential configured. Set JARVIS_CRED_NZB_M365_OAUTH " +
          "(NZB tenant app registration) before using this capability.",
      );
    }

    if (req.intent === "m365.mail.search") {
      const query = typeof req.payload.query === "string" ? req.payload.query : "";
      const response = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages?$search="${encodeURIComponent(query)}"`,
        { headers: { authorization: `Bearer ${ctx.credential.value}` } },
      );
      if (!response.ok) throw new Error(`nzb-m365-connector: Graph search failed (${await describeFailedResponse(response)})`);
      return response.json();
    }

    if (req.intent === "m365.mail.unreadCount") {
      const response = await fetch(
        `https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=unreadItemCount,totalItemCount`,
        { headers: { authorization: `Bearer ${ctx.credential.value}` } },
      );
      if (!response.ok) throw new Error(`nzb-m365-connector: Graph mailFolders lookup failed (${await describeFailedResponse(response)})`);
      const body = (await response.json()) as { unreadItemCount: number; totalItemCount: number };
      return { unreadCount: body.unreadItemCount, totalCount: body.totalItemCount };
    }

    if (req.intent === "dynamics.record.lookup") {
      const dynamicsBase = process.env.JARVIS_NZB_DYNAMICS_BASE_URL ?? "https://api.businesscentral.dynamics.com/v2.0";
      const recordId = String(req.payload.id ?? "");
      const response = await fetch(`${dynamicsBase}/records/${encodeURIComponent(recordId)}`, {
        headers: { authorization: `Bearer ${ctx.credential.value}` },
      });
      if (!response.ok) throw new Error(`nzb-m365-connector: Dynamics lookup failed (${await describeFailedResponse(response)})`);
      return response.json();
    }

    throw new Error(
      `nzb-m365-connector: unsupported intent "${req.intent}" — must be "m365.mail.search", "m365.mail.unreadCount", or "dynamics.record.lookup"`,
    );
  },
};

export default nzbConnectorModule;
