import type { CapabilityContext, CapabilityModule } from "../../domain/capabilityRegistry.js";
import { describeFailedResponse } from "../../domain/httpError.js";

export type WebsiteRequest =
  | { intent: "website.updateSection"; payload: { page: string; section: string; heading?: string; body: string; photo?: string } }
  | { intent: "website.addPage"; payload: { slug: string; title: string; sections?: Record<string, PageSection> } }
  | { intent: "website.replacePhoto"; payload: { path: string; attachmentIndex?: number } }
  | { intent: "website.listContent"; payload: Record<string, never> };

interface PageSection {
  heading?: string;
  body: string;
  /** Relative path under public/photos/, e.g. "farm/mob-1.jpg" — set this, then use website.replacePhoto with the same path to upload the actual bytes (two separate steps: pointing a section at a photo vs. the photo existing are independent). */
  photo?: string;
}

interface PageContent {
  title: string;
  sections: Record<string, PageSection>;
}

const GITHUB_API = "https://api.github.com";
const CONTENT_DIR = "src/content/pages";
const PHOTOS_DIR = "public/photos";

function repoConfig(): { owner: string; repo: string; branch: string } {
  const full = process.env.JARVIS_WEBSITE_GITHUB_REPO ?? "";
  const [owner, repo] = full.split("/");
  if (!owner || !repo) {
    throw new Error(
      'farm-website: JARVIS_WEBSITE_GITHUB_REPO is not set to an "owner/repo" value — cannot reach the content repo.',
    );
  }
  return { owner, repo, branch: process.env.JARVIS_WEBSITE_GITHUB_BRANCH || "main" };
}

async function getFile(
  path: string,
  token: string,
): Promise<{ sha: string; contentBase64: string } | null> {
  const { owner, repo, branch } = repoConfig();
  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`farm-website: GitHub read of "${path}" failed (${await describeFailedResponse(response)})`);
  const body = (await response.json()) as { sha: string; content: string };
  return { sha: body.sha, contentBase64: body.content.replace(/\n/g, "") };
}

async function putFile(path: string, contentBase64: string, message: string, sha: string | undefined, token: string): Promise<void> {
  const { owner, repo, branch } = repoConfig();
  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    body: JSON.stringify({ message, content: contentBase64, branch, ...(sha ? { sha } : {}) }),
  });
  if (!response.ok) throw new Error(`farm-website: GitHub write of "${path}" failed (${await describeFailedResponse(response)})`);
}

async function getPage(slug: string, token: string): Promise<{ sha: string; page: PageContent } | null> {
  const file = await getFile(`${CONTENT_DIR}/${slug}.json`, token);
  if (!file) return null;
  const page = JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8")) as PageContent;
  return { sha: file.sha, page };
}

async function putPage(slug: string, page: PageContent, message: string, sha: string | undefined, token: string): Promise<void> {
  const contentBase64 = Buffer.from(JSON.stringify(page, null, 2), "utf8").toString("base64");
  await putFile(`${CONTENT_DIR}/${slug}.json`, contentBase64, message, sha, token);
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
 * since this only ever touches public marketing content, never
 * credentials or schema).
 */
const websiteModule: CapabilityModule = {
  canHandle(request: unknown): boolean {
    const req = request as Partial<WebsiteRequest>;
    return (
      req?.intent === "website.updateSection" ||
      req?.intent === "website.addPage" ||
      req?.intent === "website.replacePhoto" ||
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
      existing.page.sections[section] = { heading: heading ?? prior?.heading, body, photo: photo ?? prior?.photo };
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
      const existing = await getFile(fullPath, token);
      await putFile(fullPath, attachment.base64Data, `website: replace photo ${photoPath} via JARVIS chat`, existing?.sha, token);
      const rebuilt = await triggerRebuild();
      return { replaced: true, path: photoPath, rebuildTriggered: rebuilt };
    }

    if (req.intent === "website.listContent") {
      const { owner, repo, branch } = repoConfig();
      const response = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/contents/${CONTENT_DIR}?ref=${encodeURIComponent(branch)}`,
        { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
      );
      if (!response.ok) throw new Error(`farm-website: listing content failed (${await describeFailedResponse(response)})`);
      const entries = (await response.json()) as Array<{ name: string }>;
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
        `"website.updateSection", "website.addPage", "website.replacePhoto", "website.listContent"`,
    );
  },
};

export default websiteModule;
