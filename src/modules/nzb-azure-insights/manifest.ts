export const nzbAzureInsightsManifest = {
  name: "nzb-azure-cost-insights",
  category: "work",
  enabled: true,
  priority: 100,
  schema_def: {
    request: {
      intent: "'azure.cost.summary' | 'azure.orphaned-resources'",
      payload: "azure.cost.summary: { timeframe?: 'MonthToDate'|'BillingMonthToDate'|'TheLastMonth' }. azure.orphaned-resources: { preset: 'unattached-disks'|'unassociated-public-ips' }",
    },
  },
  system_prompt:
    "Read-only Azure cost and orphaned-resource analysis for the NZB subscription, via the Cost Management API " +
    "and Resource Graph (an app registration granted only Reader + Cost Management Reader RBAC — never " +
    "Contributor or any admin role). Use it to answer questions about spend and to find idle/unattached " +
    "resources (disks, public IPs) that are costing money unused. Standing application/RBAC grants like this " +
    "are NOT gated by PIM the way a human admin's role activation is, which is exactly why this credential is " +
    "kept read-only. This capability can never delete, resize, or modify a resource — report findings and " +
    "recommend cleanup, but any actual deletion needs a human with PIM-activated Contributor access, or should " +
    "go through a reviewer proposal for the user to act on themselves.",
  tool_config: { provider: "azure-resource-graph", tenant: "nzb", scopes: ["Reader", "Cost Management Reader"] },
  model_override: null,
  credential_ref: "nzb-azure-insights-oauth",
  module_path: "nzb-azure-insights",
};
