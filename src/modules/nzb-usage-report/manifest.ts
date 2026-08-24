export const nzbUsageReportManifest = {
  name: "nzb-m365-usage-report",
  category: "work",
  enabled: true,
  priority: 100,
  schema_def: {
    request: {
      intent: "'m365.usage.report'",
      payload: "{ report: one of getOffice365ActiveUserDetail | getMailboxUsageDetail | getM365AppUserDetail | getOffice365ServicesUserCounts, period?: 'D7'|'D30'|'D90'|'D180' }",
    },
  },
  system_prompt:
    "Read-only Microsoft 365 usage and license reporting for the NZB tenant, via Microsoft Graph's Reports API " +
    "(Reports.Read.All — a standing but strictly read-only application permission; note this is NOT gated by " +
    "PIM the way an admin's own role activation is, so it only ever reads report data, never directory content). " +
    "Use it to answer questions about mailbox usage, app usage, or which licenses/mailboxes look unused. This " +
    "capability cannot change, remove, or reassign anything — if the user wants a cleanup acted on, tell them " +
    "what you found and that removing a license or disabling an account needs to be done by an admin with PIM " +
    "activated (or via a proposal in the dashboard), never by this capability directly.\n\n" +
    "Call it with intent \"m365.usage.report\" and payload exactly " +
    '{"report": "<one of getOffice365ActiveUserDetail, getMailboxUsageDetail, getM365AppUserDetail, ' +
    'getOffice365ServicesUserCounts>", "period": "<one of D7, D30, D90, D180, defaults to D30>"}. ' +
    'The "report" field is required — never call this without it. The result comes back as ' +
    '{report, period, format: "csv", data: "<CSV text>"} — Graph only supports CSV for these report endpoints, ' +
    "so parse/summarize the CSV yourself rather than expecting JSON.",
  tool_config: { provider: "microsoft-graph", tenant: "nzb", scopes: ["Reports.Read.All"] },
  model_override: null,
  credential_ref: "nzb-usage-report-oauth",
  module_path: "nzb-usage-report",
};
