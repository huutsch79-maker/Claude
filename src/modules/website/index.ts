import type { CapabilityContext, CapabilityModule } from "../../domain/capabilityRegistry.js";
import { getFile, putFile, listDir, websiteRepoRef } from "../../domain/githubContentsApi.js";

export type WebsiteRequest =
  | { intent: "website.updateSection"; payload: { page: string; section: string; heading?: string; body?: string; photo?: string } }
  | { intent: "website.addPage"; payload: { slug: string; title: string; sections?: Record<string, PageSection> } }
  | { intent: "website.replacePhoto"; payload: { path: string; attachmentIndex?: number } }
  | { intent: "website.updateStyle"; payload: { path: string; oldCss: string; newCss: string } }
  | { intent: "website.readFile"; payload: { path: string } }
  | { intent: "website.listContent"; payload: Record<string, never> };

const READ_FILE_MAX_CHARS = 8000;

interface PageSection {
  heading?: string;
  body: string;
  /** Relative path under src/assets/photos/, e.g. "farm/mob-1.jpg" — set this, then use website.replacePhoto with the same path to upload the actual bytes (two separate steps: pointing a section at a photo vs. the photo existing are independent). */
  photo?: string;
}

interface PageContent {
  title: string;
  sections: Record<string, PageSection>;
}

/**
 * On-disk shape differs from PageContent on purpose: Sveltia/Decap CMS's
 * "list" widget (used in admin/config.yml so a human can add/reorder/edit
 * sections visually) needs each item to have a fixed set of fields,
 * including its own key — it can't bind to an arbitrary keyed map. Chat's
 * payload shape stays the more ergonomic Record<string, PageSection>
 * (see WebsiteRequest above); only the file on disk uses the list form,
 * converted at the read/write boundary below.
 */
interface StoredSection extends PageSection {
  key: string;
}
interface StoredPageContent {
  title: string;
  sections: StoredSection[];
}

function fromStored(stored: StoredPageContent): PageContent {
  const sections: Record<string, PageSection> = {};
  for (const { key, ...section } of stored.sections) sections[key] = section;
  return { title: stored.title, sections };
}

function toStored(page: PageContent): StoredPageContent {
  return { title: page.title, sections: Object.entries(page.sections).map(([key, section]) => ({ key, ...section })) };
}

const CONTENT_DIR = "src/content/pages";
// src/assets/, not public/ — only images under src/ go through Astro's
// real build-time image pipeline (resize, re-encode, srcset); public/
// serves whatever bytes were uploaded, unprocessed, which is what caused
// the hero photo to look pixelated at larger viewport widths. See
// waikatohighlands-website's README.md "Image pipeline" section.
const PHOTOS_DIR = "src/assets/photos";

async function getPage(slug: string, token: string): Promise<{ sha: string; page: PageContent } | null> {
  const file = await getFile(websiteRepoRef(), `${CONTENT_DIR}/${slug}.json`, token);
  if (!file) return null;
  const stored = JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8")) as StoredPageContent;
  return { sha: file.sha, page: fromStored(stored) };
}

async function putPage(slug: string, page: PageContent, message: string, sha: string | undefined, token: string): Promise<void> {
  const contentBase64 = Buffer.from(JSON.stringify(toStored(page), null, 2), "utf8").toString("base64");
  await putFile(websiteRepoRef(), `${CONTENT_DIR}/${slug}.json`, contentBase64, message, sha, token);
}

/**
 * Best-effort: tells the website-server container to pull the latest
 * commit and rebuild right away, instead of waiting for its next periodic
 * rebuild. Never allowed to fail the chat turn — the GitHub commit is the
 * actual source of truth and already succeeded by the time this runs; a
 * rebuild-trigger failure just means the live site catches up a bit later
 * instead of instantly.
 */
async function triggerRebuild(): Promise<boolean> {
  const url = process.env.JARVIS_WEBSITE_REBUILD_URL;
  if (!url) return false;
  try {
    const response = await fetch(url, { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Edits waikatohighlands.com's content by committing directly to its
 * GitHub repo — the same repo and files a human edits through the Sveltia
 * CMS admin UI, so the two never conflict, they're just two more
 * contributors to the same git history. See docs/architecture.md's
 * "Website module" section for the full repo-split rationale and the
 * instant-publish flow (this module commits, then pokes website-server's
 * internal rebuild endpoint — never waits for a human approval step,
 * since everything here is content or CSS, never markup/logic/config/
 * dependencies — those go through the apply-website-file bounded script
 * instead, which IS approval-gated; see scriptRegistry.ts).
 */
const websiteModule: CapabilityModule = {
  canHandle(request: unknown): boolean {
    const req = request as Partial<WebsiteRequest>;
    return (
      req?.intent === "website.updateSection" ||
      req?.intent === "website.addPage" ||
      req?.intent === "website.replacePhoto" ||
      req?.intent === "website.updateStyle" ||
      req?.intent === "website.readFile" ||
      req?.intent === "website.listContent"
    );
  },

  async handle(request: unknown, ctx: CapabilityContext): Promise<unknown> {
    const req = request as WebsiteRequest;
    if (!ctx.credential) {
      throw new Error(
        "farm-website: no credential configured. Set JARVIS_CRED_WEBSITE_GITHUB (a GitHub token scoped to just " +
          "the content repo) before using this capability.",
      );
    }
    const token = ctx.credential.value;

    if (req.intent === "website.updateSection") {
      const { page: slug, section, heading, body, photo } = req.payload;
      const existing = await getPage(slug, token);
      if (!existing) {
        throw new Error(`farm-website: page "${slug}" does not exist — use website.addPage to create it first.`);
      }
      const prior = existing.page.sections[section];
      const resolvedBody = body ?? prior?.body;
      if (resolvedBody === undefined) {
        throw new Error(
          `farm-website: section "${section}" on page "${slug}" doesn't exist yet, so "body" is required to create ` +
            `it — there is no prior text to leave unchanged.`,
        );
      }
      existing.page.sections[section] = { heading: heading ?? prior?.heading, body: resolvedBody, photo: photo ?? prior?.photo };
      await putPage(slug, existing.page, `website: update ${slug}/${section} via JARVIS chat`, existing.sha, token);
      const rebuilt = await triggerRebuild();
      return { updated: true, page: slug, section, rebuildTriggered: rebuilt };
    }

    if (req.intent === "website.addPage") {
      const { slug, title, sections } = req.payload;
      const existing = await getPage(slug, token);
      if (existing) {
        throw new Error(`farm-website: page "${slug}" already exists — use website.updateSection to change it.`);
      }
      await putPage(slug, { title, sections: sections ?? {} }, `website: add page ${slug} via JARVIS chat`, undefined, token);
      const rebuilt = await triggerRebuild();
      return { created: true, page: slug, rebuildTriggered: rebuilt };
    }

    if (req.intent === "website.replacePhoto") {
      const { path: photoPath, attachmentIndex } = req.payload;
      const attachment = ctx.attachments[attachmentIndex ?? 0];
      if (!attachment) {
        throw new Error(
          "farm-website: website.replacePhoto requires the user to have attached an image to this message — " +
            "there is no other way to get photo bytes into this capability.",
        );
      }
      if (!attachment.mediaType.startsWith("image/")) {
        throw new Error(`farm-website: attachment is "${attachment.mediaType}", not an image — refusing to use it as a photo.`);
      }
      const fullPath = `${PHOTOS_DIR}/${photoPath}`;
      const existing = await getFile(websiteRepoRef(), fullPath, token);
      await putFile(websiteRepoRef(), fullPath, attachment.base64Data, `website: replace photo ${photoPath} via JARVIS chat`, existing?.sha, token);
      const rebuilt = await triggerRebuild();
      return { replaced: true, path: photoPath, rebuildTriggered: rebuilt };
    }

    if (req.intent === "website.updateStyle") {
      const { path, oldCss, newCss } = req.payload;
      const file = await getFile(websiteRepoRef(), path, token);
      if (!file) throw new Error(`farm-website: "${path}" does not exist — website.updateStyle only edits existing files.`);
      const text = Buffer.from(file.contentBase64, "base64").toString("utf8");

      // Confined to a <style>...</style> block for .astro files (Astro's
      // scoped-style pattern) so this intent can only ever touch CSS, never
      // markup/frontmatter/logic in the same file — that split is the whole
      // reason website.updateStyle gets to publish instantly while anything
      // else structural has to go through the approval-gated
      // apply-website-file script instead.
      const styleMatch = path.endsWith(".css") ? { start: 0, end: text.length } : findStyleBlock(text);
      if (!styleMatch) {
        throw new Error(`farm-website: no <style> block found in "${path}" — website.updateStyle can't edit non-CSS content.`);
      }
      const styleRegion = text.slice(styleMatch.start, styleMatch.end);
      const matchIndex = styleRegion.indexOf(oldCss);
      if (matchIndex === -1) {
        throw new Error(
          `farm-website: the given "oldCss" text wasn't found inside "${path}"'s style block — call website.listContent-style ` +
            `inspection isn't available for CSS, so re-check the exact current text before retrying rather than guessing.`,
        );
      }
      const newStyleRegion = styleRegion.slice(0, matchIndex) + newCss + styleRegion.slice(matchIndex + oldCss.length);
      const newText = text.slice(0, styleMatch.start) + newStyleRegion + text.slice(styleMatch.end);

      await putFile(
        websiteRepoRef(),
        path,
        Buffer.from(newText, "utf8").toString("base64"),
        `website: update styles in ${path} via JARVIS chat`,
        file.sha,
        token,
      );
      const rebuilt = await triggerRebuild();
      return { updated: true, path, rebuildTriggered: rebuilt };
    }

    if (req.intent === "website.readFile") {
      const { path } = req.payload;
      const file = await getFile(websiteRepoRef(), path, token);
      if (!file) throw new Error(`farm-website: "${path}" does not exist in the website repo.`);
      const text = Buffer.from(file.contentBase64, "base64").toString("utf8");
      if (text.length > READ_FILE_MAX_CHARS) {
        return {
          path,
          content: text.slice(0, READ_FILE_MAX_CHARS),
          truncated: true,
          note: `truncated at ${READ_FILE_MAX_CHARS} of ${text.length} characters — ask for a narrower file or a specific section if you need what's past this point`,
        };
      }
      return { path, content: text, truncated: false };
    }

    if (req.intent === "website.listContent") {
      const entries = await listDir(websiteRepoRef(), CONTENT_DIR, token);
      const slugs = entries.filter((e) => e.name.endsWith(".json")).map((e) => e.name.replace(/\.json$/, ""));
      const pages = await Promise.all(
        slugs.map(async (slug) => {
          const page = await getPage(slug, token);
          return { slug, title: page?.page.title ?? "", sections: Object.keys(page?.page.sections ?? {}) };
        }),
      );
      return { pages };
    }

    // Fail closed: an unrecognized intent must never silently fall through
    // to any of the above — same reasoning as hotmail-outlook and
    // nzb-m365-connector (see their index.ts files).
    throw new Error(
      `farm-website: unsupported intent "${(req as { intent?: string }).intent}" — must be one of ` +
        `"website.updateSection", "website.addPage", "website.replacePhoto", "website.updateStyle", "website.readFile", "website.listContent"`,
    );
  },
};

/** First <style>...</style> block's inner content range, or null if the file has none. */
function findStyleBlock(text: string): { start: number; end: number } | null {
  const openMatch = /<style(?:\s[^>]*)?>/i.exec(text);
  if (!openMatch) return null;
  const start = openMatch.index + openMatch[0].length;
  const end = text.indexOf("</style>", start);
  if (end === -1) return null;
  return { start, end };
}

export default websiteModule;
