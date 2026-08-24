/**
 * Registry row for this capability, inserted by scripts/seed-registry.ts.
 * module_path is a logical "domain/name" id, not a filesystem path — see
 * CapabilityRow.modulePath in src/domain/capabilityRegistry.ts for why.
 * Dropping a new module directory + a row like this one is the entire
 * "add a module" flow.
 */
export const hotmailManifest = {
  name: "hotmail-outlook",
  enabled: true,
  priority: 100,
  schema_def: {
    request: { intent: "string (e.g. 'email.search', 'email.send')", payload: "object" },
  },
  system_prompt:
    "You can read and send email on the user's personal Hotmail/Outlook account via Microsoft Graph. " +
    "Never use this for anything work-related — that belongs to the work domain's own connector.",
  tool_config: { provider: "microsoft-graph", scopes: ["Mail.Read", "Mail.Send"] },
  model_override: null,
  credential_ref: "hotmail-oauth",
  module_path: "personal/hotmail",
};
