import type { CapabilityContext, CapabilityModule } from "../../domain/capabilityRegistry.js";
import { getAppOnlyAccessToken } from "../../domain/appOnlyTokenProvider.js";
import { describeFailedResponse } from "../../domain/httpError.js";

const ARM_SCOPE = "https://management.azure.com/.default";

export interface AzureInsightsRequest {
  intent: "azure.cost.summary" | "azure.orphaned-resources";
  payload: { timeframe?: string; preset?: string };
}

// Fixed, reviewed KQL queries — never build a query from caller input, so
// this can't turn into an arbitrary (and potentially expensive or
// leaking) Resource Graph query.
const RESOURCE_GRAPH_PRESETS: Record<string, string> = {
  "unattached-disks":
    "Resources | where type =~ 'microsoft.compute/disks' | where properties.diskState =~ 'Unattached' " +
    "| project name, resourceGroup, location, sizeGB=properties.diskSizeGB",
  "unassociated-public-ips":
    "Resources | where type =~ 'microsoft.network/publicipaddresses' | where isnull(properties.ipConfiguration) " +
    "| project name, resourceGroup, location",
};

/**
 * Read-only Azure cost/orphaned-resource analysis via the Cost Management
 * and Resource Graph APIs. Its own capability, its own narrow credential
 * (Reader + Cost Management Reader RBAC only) — see manifest.ts for why a
 * standing grant here has to stay read-only: it bypasses the PIM
 * activation flow a human admin would normally go through.
 */
const nzbAzureInsightsModule: CapabilityModule = {
  canHandle(request: unknown): boolean {
    const req = request as Partial<AzureInsightsRequest>;
    return req?.intent === "azure.cost.summary" || req?.intent === "azure.orphaned-resources";
  },

  async handle(request: unknown, ctx: CapabilityContext): Promise<unknown> {
    const req = request as AzureInsightsRequest;
    if (!ctx.credential) {
      throw new Error(
        "nzb-azure-cost-insights: no credential configured. Set JARVIS_CRED_NZB_AZURE_INSIGHTS_OAUTH to " +
          '{"tenantId":"...","clientId":"...","clientSecret":"..."} for an app registration granted only ' +
          "Reader + Cost Management Reader before using this capability.",
      );
    }

    const accessToken = await getAppOnlyAccessToken(ctx.credential.value, ARM_SCOPE);

    if (req.intent === "azure.cost.summary") {
      const subscriptionId = process.env.JARVIS_NZB_AZURE_SUBSCRIPTION_ID;
      if (!subscriptionId) throw new Error("nzb-azure-cost-insights: JARVIS_NZB_AZURE_SUBSCRIPTION_ID is not set");
      const timeframe = req.payload.timeframe ?? "MonthToDate";
      const response = await fetch(
        `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            type: "ActualCost",
            timeframe,
            dataset: {
              granularity: "None",
              aggregation: { totalCost: { name: "Cost", function: "Sum" } },
              grouping: [{ type: "Dimension", name: "ResourceGroupName" }],
            },
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`nzb-azure-cost-insights: Cost Management query failed (${await describeFailedResponse(response)})`);
      }
      return response.json();
    }

    // azure.orphaned-resources
    const preset = req.payload.preset ?? "";
    const query = RESOURCE_GRAPH_PRESETS[preset];
    if (!query) {
      throw new Error(`nzb-azure-cost-insights: unknown preset "${preset}" — must be one of ${Object.keys(RESOURCE_GRAPH_PRESETS).join(", ")}`);
    }
    const response = await fetch("https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) {
      throw new Error(`nzb-azure-cost-insights: Resource Graph query failed (${await describeFailedResponse(response)})`);
    }
    return response.json();
  },
};

export default nzbAzureInsightsModule;
