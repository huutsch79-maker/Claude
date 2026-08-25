/**
 * Registry row for this capability, inserted by scripts/seed-registry.ts.
 * module_path is a logical id, not a filesystem path — see
 * CapabilityRow.modulePath in src/domain/capabilityRegistry.ts for why.
 * `category` is a freeform UI label only — not an access boundary.
 * Dropping a new module directory + a row like this one is the entire
 * "add a module" flow.
 *
 * IMAP/SMTP with an app password, not Graph OAuth — deliberately. This is
 * a personal mailbox with no connection to any employer's tenant, and an
 * Entra app registration always has to live inside *some* Entra tenant;
 * routing a personal account's mail access through NZB's tenant (even
 * just for app-registration metadata) wasn't the right tradeoff here. A
 * personal Outlook.com/Hotmail account's own app-password + IMAP/SMTP
 * avoids Entra entirely. See docs/architecture.md "Delegated OAuth" for
 * why nzb-m365-connector — a real organizational mailbox — still uses the
 * OAuth path instead.
 */
export const hotmailManifest = {
  name: "hotmail-outlook",
  category: "personal",
  enabled: true,
  priority: 100,
  schema_def: {
    request: {
      intent: "'email.search' | 'email.send'",
      payload: "email.search: { query?: string }. email.send: { to: string, subject: string, body: string }",
    },
  },
  system_prompt:
    "You can read and send email on the user's personal Hotmail/Outlook account via IMAP/SMTP (an app " +
    "password, not OAuth — this account has no connection to NZB). Call with intent \"email.search\" and " +
    'payload {"query": "<optional search text>"} for the 20 most recent matching messages, or intent ' +
    '"email.send" with payload {"to": "...", "subject": "...", "body": "..."} to send one.',
  tool_config: { provider: "imap-smtp", host: "outlook.office365.com" },
  model_override: null,
  credential_ref: "hotmail-imap",
  module_path: "hotmail",
};
