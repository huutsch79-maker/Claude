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
      intent:
        "'website.updateSection' | 'website.addPage' | 'website.replacePhoto' | 'website.updateStyle' | " +
        "'website.readFile' | 'website.listContent'",
      payload:
        "website.updateSection: { page: string, section: string, heading?: string, body?: string, photo?: string }. " +
        "website.addPage: { slug: string, title: string, sections?: { [key]: { heading?: string, body: string, photo?: string } } }. " +
        "website.replacePhoto: { path: string, attachmentIndex?: number }. " +
        "website.updateStyle: { path: string, oldCss: string, newCss: string }. " +
        "website.readFile: { path: string }. " +
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
    "for the first) if more than one was sent. Call with intent exactly \"website.updateStyle\" and payload " +
    '{"path": "<file, e.g. \\"src/components/Hero.astro\\" or a .css file>", "oldCss": "<exact existing CSS text>", ' +
    '"newCss": "<its replacement>"} for a pure visual/CSS tweak (colors, spacing, image cropping, sizing) — this ' +
    "also publishes instantly, since it can only ever touch CSS inside a <style> block, never markup or logic. " +
    '"oldCss" must match the file\'s actual current text exactly, byte for byte — never guess it or assume it from ' +
    'memory. Before calling "website.updateStyle" (or before writing "contentBase64" for "apply-website-file" ' +
    'below), call "website.readFile" with payload {"path": "<file path>"} to fetch that file\'s real current content ' +
    "first; only ask the user to paste something themselves if you don't yet know which file the thing they're " +
    'describing actually lives in. Call with intent exactly "website.listContent" and payload {} to see what pages ' +
    "and sections currently exist before editing, rather than guessing page/section names. Any other intent value " +
    "is rejected.\n\n" +
    "Anything beyond content and CSS — page markup/logic (.astro files' frontmatter or template), " +
    "astro.config.mjs, the content schema, admin/config.yml, package.json, or any new/deleted file — is NOT " +
    'available through this capability at all. Use the run_script tool instead, with name "apply-website-file" ' +
    'and args {"path": "<file path in the site repo>", "contentBase64": "<the full new file content, base64-encoded>"}. ' +
    'contentBase64 must be the file\'s ENTIRE new content, not a diff or a fragment — read the current content with ' +
    '"website.readFile" first when editing an existing file, apply your change to it, then base64-encode the whole ' +
    "result. This publishes instantly too, same as everything above — there is no human review step before a " +
    "structural change goes live, so get it right the first time. A bad file here can break the whole site's " +
    "build, not just one page, so be conservative: read the current file first, never guess syntax or invent " +
    "content you don't actually have, and if you're not confident the change is correct, say so and ask rather " +
    'than publish a guess. Never try to approximate a structural change (a new page layout, a new component, a ' +
    'dependency bump) through "website.updateSection" or "website.updateStyle" — use "apply-website-file" for ' +
    "all of it. The one thing this can never touch is .github/ — that's a hardcoded refusal, not part of this " +
    "capability's judgment call, since it can grant CI code execution.\n\n" +
    "Photo slots are numbered, in src/photoSlots.ts — a hand-maintained list of every {page, section} that can " +
    'hold a photo, each with a stable number (e.g. "photo 4" always means the same page/section until that ' +
    "slot is removed). When the user refers to a photo by number (\"swap photo 2\", \"what's photo 4\") read " +
    'src/photoSlots.ts with "website.readFile" to resolve which page and section they mean, rather than asking ' +
    "them to spell it out. Every existing page template already looks up a section's number from this file " +
    "automatically at render time — you never need to touch index.astro/about.astro/farm.astro/[slug].astro to " +
    "make a number show up. When you add a new page or a new section that has (or should have) a photo — via " +
    '"website.addPage" or "website.updateSection" — also append one entry for it to the end of ' +
    "src/photoSlots.ts's PHOTO_SLOTS array (via \"apply-website-file\"), with the next unused number. Always " +
    "append; never renumber or reuse an existing entry's number, even if a slot is later removed — that would " +
    "silently change what a number the user already knows about refers to. On the farm page specifically, a " +
    'photo only ever renders for a section whose key starts with "mob" — adding photoSlots.ts entries for other ' +
    "farm sections wouldn't actually show anything, so don't.",
  tool_config: { provider: "github-contents-api", scopes: ["contents:write"] },
  model_override: null,
  credential_ref: "website-github",
  module_path: "website",
};
