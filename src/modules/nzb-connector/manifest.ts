export const nzbConnectorManifest = {
  name: "nzb-m365-connector",
  category: "work",
  enabled: true,
  priority: 100,
  schema_def: {
    request: { intent: "string (e.g. 'm365.mail.search', 'dynamics.record.lookup')", payload: "object" },
  },
  system_prompt: "You can access NZB's M365/Dynamics BC data on the user's behalf.",
  tool_config: { provider: "microsoft-graph", tenant: "nzb", scopes: ["Mail.Read"] },
  model_override: null,
  credential_ref: "nzb-m365-oauth",
  module_path: "nzb-connector",
};
