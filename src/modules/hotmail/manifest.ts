/**
 * Registry row for this capability, inserted by scripts/seed-registry.ts.
 * module_path is a logical id, not a filesystem path — see
 * CapabilityRow.modulePath in src/domain/capabilityRegistry.ts for why.
 * `category` is a freeform UI label only — not an access boundary.
 * Dropping a new module directory + a row like this one is the entire
 * "add a module" flow.
 */
export const hotmailManifest = {
  name: "hotmail-outlook",
  category: "personal",
  enabled: true,
  priority: 100,
  schema_def: {
    request: {
      intent: "'email.search' | 'email.send'",
      payload: "email.search: { query?: string }. email.send: { toRecipients: [...], subject: string, body: {...} } — Graph sendMail message shape",
    },
  },
  system_prompt:
    "You can read and send email on the user's personal Hotmail/Outlook account via Microsoft Graph. Call with " +
    'intent exactly "email.search" and payload {"query": "<optional search text>"} to search/list messages, or ' +
    'intent exactly "email.send" and payload shaped as a Graph message object (e.g. {"toRecipients": ' +
    '[{"emailAddress": {"address": "..."}}], "subject": "...", "body": {"contentType": "Text", "content": "..."}}) ' +
    "to send one. Any other intent value is rejected, not treated as a send — never guess a close-enough intent name.",
  tool_config: { provider: "microsoft-graph", scopes: ["Mail.Read", "Mail.Send"] },
  model_override: null,
  credential_ref: "hotmail-oauth",
  module_path: "hotmail",
};
