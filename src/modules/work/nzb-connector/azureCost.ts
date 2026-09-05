import type { AzureCostSummary } from "../../../orchestrator/domainContentSummary.js";
import { MAX_DISPLAY_NAME_LEN, MAX_TOP_SERVICES } from "../../../orchestrator/domainContentSummary.js";

const REQUIRED_ENV_VARS = [
  "JARVIS_WORK_AZURE_TENANT_ID",
  "JARVIS_WORK_AZURE_CLIENT_ID",
  "JARVIS_WORK_AZURE_CLIENT_SECRET",
  "JARVIS_WORK_AZURE_SUBSCRIPTION_ID",
] as const;

const DEFAULT_CURRENCY = "USD";

/**
 * One real, focused Azure Cost Management slice, work domain only. Per the
 * Architect's explicit deviation, these four env vars are read directly
 * (not via CredentialStore.get) because they're an Azure AD app
 * registration's ARM client-credentials, not a CredentialStore-shaped
 * single token/expiry pair. Never throws.
 */
export async function fetchAzureCostSummary(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<AzureCostSummary> {
  const tenantId = env.JARVIS_WORK_AZURE_TENANT_ID;
  const clientId = env.JARVIS_WORK_AZURE_CLIENT_ID;
  const clientSecret = env.JARVIS_WORK_AZURE_CLIENT_SECRET;
  const subscriptionId = env.JARVIS_WORK_AZURE_SUBSCRIPTION_ID;

  if (!tenantId || !clientId || !clientSecret || !subscriptionId) {
    return notConfigured();
  }

  try {
    const accessToken = await acquireArmToken(tenantId, clientId, clientSecret, fetchImpl);
    const queryResponse = await fetchImpl(
      `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          type: "ActualCost",
          timeframe: "MonthToDate",
          dataset: {
            granularity: "None",
            aggregation: { totalCost: { name: "Cost", function: "Sum" } },
            grouping: [{ type: "Dimension", name: "ServiceName" }],
          },
        }),
      },
    );
    if (!queryResponse.ok) throw new Error(`Cost Management query failed (${queryResponse.status})`);
    const body = (await queryResponse.json()) as CostQueryResponse;
    return aggregateCostQuery(body);
  } catch {
    return errorResult();
  }
}

interface CostQueryResponse {
  properties?: {
    columns?: { name: string }[];
    rows?: unknown[][];
  };
}

async function acquireArmToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://management.azure.com/.default",
  });
  const res = await fetchImpl(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`ARM token acquisition failed (${res.status})`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("ARM token response missing access_token");
  return json.access_token;
}

function aggregateCostQuery(body: CostQueryResponse): AzureCostSummary {
  const columns = body.properties?.columns ?? [];
  const rows = body.properties?.rows ?? [];
  const costIdx = columns.findIndex((c) => c.name === "Cost");
  const serviceIdx = columns.findIndex((c) => c.name === "ServiceName");
  const currencyIdx = columns.findIndex((c) => c.name === "Currency");

  if (costIdx === -1 || rows.length === 0) {
    return {
      status: "connected",
      currency: DEFAULT_CURRENCY,
      monthToDateCost: 0,
      topServices: [],
      lastSyncedAt: new Date().toISOString(),
    };
  }

  let total = 0;
  const perService = new Map<string, number>();
  let currency = DEFAULT_CURRENCY;
  for (const row of rows) {
    const cost = typeof row[costIdx] === "number" ? (row[costIdx] as number) : Number(row[costIdx] ?? 0);
    total += cost;
    const serviceName = serviceIdx !== -1 ? String(row[serviceIdx] ?? "unknown") : "unknown";
    perService.set(serviceName, (perService.get(serviceName) ?? 0) + cost);
    if (currencyIdx !== -1 && typeof row[currencyIdx] === "string") {
      currency = row[currencyIdx] as string;
    }
  }

  const topServices = Array.from(perService.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOP_SERVICES)
    .map(([serviceName, cost]) => ({ serviceName: serviceName.slice(0, MAX_DISPLAY_NAME_LEN), cost }));

  return {
    status: "connected",
    currency,
    monthToDateCost: total,
    topServices,
    lastSyncedAt: new Date().toISOString(),
  };
}

function notConfigured(): AzureCostSummary {
  return { status: "not_configured", currency: DEFAULT_CURRENCY, monthToDateCost: null, topServices: [], lastSyncedAt: null };
}

function errorResult(): AzureCostSummary {
  return { status: "error", currency: DEFAULT_CURRENCY, monthToDateCost: null, topServices: [], lastSyncedAt: null };
}

export { REQUIRED_ENV_VARS };
