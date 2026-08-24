import type { CapabilityContext, CapabilityModule } from "../../domain/capabilityRegistry.js";
import { getAppOnlyAccessToken } from "../../domain/appOnlyTokenProvider.js";

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

export interface UsageReportRequest {
  intent: "m365.usage.report";
  payload: { report: string; period?: string };
}

// Fixed allowlist of Graph usage reports — never pass the caller's report
// name straight into the URL, so this can't be turned into an arbitrary
// Graph endpoint call.
const ALLOWED_REPORTS = new Set([
  "getOffice365ActiveUserDetail",
  "getMailboxUsageDetail",
  "getM365AppUserDetail",
  "getOffice365ServicesUserCounts",
]);

/**
 * Read-only M365 usage/license reporting via Microsoft Graph's Reports
 * API. Deliberately its own capability (separate from nzb-connector) with
 * its own narrow credential — Reports.Read.All only, nothing that can
 * write to the directory. See manifest.ts for why: standing Graph
 * application permissions bypass PIM's activation model entirely, so the
 * only safe posture is keeping this capability's own standing grant as
 * narrow as possible.
 */
const nzbUsageReportModule: CapabilityModule = {
  canHandle(request: unknown): boolean {
    const req = request as Partial<UsageReportRequest>;
    return req?.intent === "m365.usage.report";
  },

  async handle(request: unknown, ctx: CapabilityContext): Promise<unknown> {
    const req = request as UsageReportRequest;
    if (!ctx.credential) {
      throw new Error(
        "nzb-m365-usage-report: no credential configured. Set JARVIS_CRED_NZB_USAGE_REPORT_OAUTH to " +
          '{"tenantId":"...","clientId":"...","clientSecret":"..."} for an app registration granted only ' +
          "Reports.Read.All before using this capability.",
      );
    }

    const report = req.payload.report;
    if (!ALLOWED_REPORTS.has(report)) {
      throw new Error(`nzb-m365-usage-report: unsupported report "${report}"`);
    }
    const period = req.payload.period ?? "D30";

    const accessToken = await getAppOnlyAccessToken(ctx.credential.value, GRAPH_SCOPE);
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/reports/${report}(period='${period}')?$format=application/json`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) throw new Error(`nzb-m365-usage-report: Graph report failed (${response.status})`);
    return response.json();
  },
};

export default nzbUsageReportModule;
