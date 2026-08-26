export const nzbConnectorManifest = {
  name: "nzb-m365-connector",
  category: "work",
  enabled: true,
  priority: 100,
  schema_def: {
    request: {
      intent: "'m365.mail.search' | 'm365.mail.unreadCount' | 'dynamics.record.lookup'",
      payload: "m365.mail.search: { query?: string }. m365.mail.unreadCount: {}. dynamics.record.lookup: { id: string }",
    },
  },
  system_prompt:
    "You can access NZB's M365/Dynamics BC data on the user's behalf. Call with intent exactly " +
    '"m365.mail.search" and payload {"query": "<optional search text>"}, intent exactly ' +
    '"m365.mail.unreadCount" and payload {} for the inbox\'s unread/total counts (also what powers the ' +
    "dashboard's unread-email stat tile), or intent exactly " +
    '"dynamics.record.lookup" and payload {"id": "<record id>"}. Any other intent value is rejected.',
  tool_config: { provider: "microsoft-graph", tenant: "nzb", scopes: ["Mail.Read"] },
  model_override: null,
  credential_ref: "nzb-m365-oauth",
  module_path: "nzb-connector",
};
