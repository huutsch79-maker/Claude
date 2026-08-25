/**
 * Registry row for this capability, inserted by scripts/seed-registry.ts.
 * See src/modules/hotmail/manifest.ts for the general pattern this follows.
 *
 * Content lives in a separate GitHub repo (JARVIS_WEBSITE_GITHUB_REPO),
 * not this one — see docs/architecture.md's "Website module" section for
 * why the split exists. credential_ref points at a GitHub token scoped to
 * just that one content repo, never the token used by githubIssueReporter
 * for the autonomous fix loop.
 */
export const websiteManifest = {
  name: "farm-website",
  category: "farm",
  enabled: true,
  priority: 100,
  schema_def: {
    request: {
      intent: "'website.updateSection' | 'website.addPage' | 'website.replacePhoto' | 'website.listContent'",
      payload:
        "website.updateSection: { page: string, section: string, heading?: string, body?: string, photo?: string }. " +
        "website.addPage: { slug: string, title: string, sections?: { [key]: { heading?: string, body: string, photo?: string } } }. " +
        "website.replacePhoto: { path: string, attachmentIndex?: number }. " +
        "website.listContent: {}",
    },
  },
  system_prompt:
    "You can edit the content of waikatohighlands.com — changes go live immediately, there is no separate " +
    'publish/approval step, so only make the exact change asked for. Call with intent exactly "website.updateSection" ' +
    'and payload {"page": "<page slug, e.g. \\"about\\">", "section": "<section key>", "heading": "<optional new heading>", ' +
    '"body": "<optional new section text>", "photo": "<optional path under photos/, e.g. \\"farm/mob-1.jpg\\", pointing ' +
    'this section at a photo>"} to change an existing page\'s section — the page must already exist (use ' +
    '"website.addPage" first if it does not). Just like "heading" and "photo", omit "body" entirely to leave the ' +
    'existing text unchanged — do not resend it verbatim just to "confirm" it; only include "body" when you are ' +
    "actually changing that text (a new section being created for the first time still needs it, since there is " +
    'nothing to fall back to). Setting "photo" only points the section at that path; upload the ' +
    'actual image separately with "website.replacePhoto" using the same path. Call with intent exactly ' +
    '"website.addPage" and payload {"slug": "<new page slug>", "title": "<page title>", "sections": {"<key>": ' +
    '{"heading": "<...>", "body": "<...>", "photo": "<optional path>"}}} to create a brand new page — fails if ' +
    'that slug already exists. A new page is live at https://waikatohighlands.com/<slug> immediately (a generic ' +
    "layout renders it automatically), but it is NOT added to the site's navigation menu — mention the direct URL " +
    'to the user rather than implying it appears in the nav. Call with intent exactly "website.replacePhoto" ' +
    'and payload {"path": "<e.g. \\"about/family.jpg\\">", "attachmentIndex": 0} to add or replace a photo — this ONLY ' +
    "works when the user has attached an image to their current message; attachmentIndex picks which attachment (0 " +
    "for the first) if more than one was sent. Call with intent exactly \"website.listContent\" and payload {} to see " +
    "what pages and sections currently exist before editing, rather than guessing page/section names. Any other " +
    "intent value is rejected.",
  tool_config: { provider: "github-contents-api", scopes: ["contents:write"] },
  model_override: null,
  credential_ref: "website-github",
  module_path: "website",
};
