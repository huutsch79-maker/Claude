import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import websiteModule from "../src/modules/website/index.js";
import type { CapabilityContext } from "../src/domain/capabilityRegistry.js";

const OWNER = "huutsch79-maker";
const REPO = "waikatohighlands-website";

function ctx(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return { credential: { ref: "website-github", value: "gh-token", expiresAt: null }, attachments: [], ...overrides };
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj, null, 2), "utf8").toString("base64");
}

/** Routes fetch calls by "METHOD url" so each test only has to describe the calls it actually cares about. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    const key = `${method} ${url}`;
    const handler = routes[key];
    if (!handler) throw new Error(`fakeFetch: no route for "${key}"`);
    return handler();
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("farm-website module", () => {
  beforeEach(() => {
    process.env.JARVIS_WEBSITE_GITHUB_REPO = `${OWNER}/${REPO}`;
    delete process.env.JARVIS_WEBSITE_GITHUB_BRANCH;
    delete process.env.JARVIS_WEBSITE_REBUILD_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.JARVIS_WEBSITE_GITHUB_REPO;
    delete process.env.JARVIS_WEBSITE_GITHUB_BRANCH;
    delete process.env.JARVIS_WEBSITE_REBUILD_URL;
  });

  it("fails closed on an unrecognized intent", async () => {
    await expect(websiteModule.handle({ intent: "website.deletePage", payload: {} }, ctx())).rejects.toThrow(
      /unsupported intent "website.deletePage"/,
    );
  });

  it("requires a credential before doing anything", async () => {
    await expect(
      websiteModule.handle({ intent: "website.listContent", payload: {} }, ctx({ credential: null })),
    ).rejects.toThrow(/no credential configured/);
  });

  it("website.updateSection merges into an existing page and commits with its SHA", async () => {
    const existingPage = { title: "About", sections: [{ key: "intro", heading: "Hi", body: "old text" }] };
    const getUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/src/content/pages/about.json?ref=main`;
    const putUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/src/content/pages/about.json`;
    let putBody: Record<string, unknown> | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        if (method === "GET" && url === getUrl) return json({ sha: "sha-1", content: b64(existingPage) });
        if (method === "PUT" && url === putUrl) {
          putBody = JSON.parse(String(init?.body));
          return json({ content: { sha: "sha-2" } });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    const result = await websiteModule.handle(
      { intent: "website.updateSection", payload: { page: "about", section: "intro", body: "new text" } },
      ctx(),
    );

    expect(result).toEqual({ updated: true, page: "about", section: "intro", rebuildTriggered: false });
    expect(putBody?.sha).toBe("sha-1");
    const written = JSON.parse(Buffer.from(putBody!.content as string, "base64").toString("utf8"));
    expect(written).toEqual({ title: "About", sections: [{ key: "intro", heading: "Hi", body: "new text" }] });
  });

  it("website.updateSection points a section at a photo path without touching other sections", async () => {
    const existingPage = { title: "Farm", sections: [{ key: "mob1", heading: "Mob One", body: "text" }] };
    const getUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/src/content/pages/farm.json?ref=main`;
    const putUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/src/content/pages/farm.json`;
    let putBody: Record<string, unknown> | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        if (method === "GET" && url === getUrl) return json({ sha: "sha-1", content: b64(existingPage) });
        if (method === "PUT" && url === putUrl) {
          putBody = JSON.parse(String(init?.body));
          return json({ content: { sha: "sha-2" } });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    await websiteModule.handle(
      { intent: "website.updateSection", payload: { page: "farm", section: "mob1", body: "text", photo: "farm/mob-1.jpg" } },
      ctx(),
    );

    const written = JSON.parse(Buffer.from(putBody!.content as string, "base64").toString("utf8"));
    expect(written).toEqual({ title: "Farm", sections: [{ key: "mob1", heading: "Mob One", body: "text", photo: "farm/mob-1.jpg" }] });
  });

  it("website.updateSection omitting body keeps the existing text instead of writing an invalid section", async () => {
    const existingPage = { title: "Home", sections: [{ key: "hero", heading: "Waikato Highlands", body: "original tagline" }] };
    const getUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/src/content/pages/home.json?ref=main`;
    const putUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/src/content/pages/home.json`;
    let putBody: Record<string, unknown> | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        if (method === "GET" && url === getUrl) return json({ sha: "sha-1", content: b64(existingPage) });
        if (method === "PUT" && url === putUrl) {
          putBody = JSON.parse(String(init?.body));
          return json({ content: { sha: "sha-2" } });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    // Only pointing the section at a new photo — no body given, same as
    // Claude reasonably omitting it to mean "leave the text alone."
    await websiteModule.handle(
      { intent: "website.updateSection", payload: { page: "home", section: "hero", photo: "home/hero.jpg" } },
      ctx(),
    );

    const written = JSON.parse(Buffer.from(putBody!.content as string, "base64").toString("utf8"));
    expect(written).toEqual({
      title: "Home",
      sections: [{ key: "hero", heading: "Waikato Highlands", body: "original tagline", photo: "home/hero.jpg" }],
    });
  });

  it("website.updateSection requires body when creating a section that doesn't exist yet", async () => {
    const existingPage = { title: "Home", sections: [] };
    const getUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/src/content/pages/home.json?ref=main`;
    vi.stubGlobal("fetch", fakeFetch({ [`GET ${getUrl}`]: () => json({ sha: "sha-1", content: b64(existingPage) }) }));

    await expect(
      websiteModule.handle({ intent: "website.updateSection", payload: { page: "home", section: "hero", heading: "Hi" } }, ctx()),
    ).rejects.toThrow(/"body" is required to create it/);
  });

  it("website.updateSection refuses to guess a page into existence", async () => {
    const getUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/src/content/pages/nope.json?ref=main`;
    vi.stubGlobal("fetch", fakeFetch({ [`GET ${getUrl}`]: () => json({ message: "Not Found" }, 404) }));

    await expect(
      websiteModule.handle({ intent: "website.updateSection", payload: { page: "nope", section: "x", body: "y" } }, ctx()),
    ).rejects.toThrow(/page "nope" does not exist/);
  });

  it("website.addPage refuses to overwrite an existing page", async () => {
    const getUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/src/content/pages/about.json?ref=main`;
    vi.stubGlobal(
      "fetch",
      fakeFetch({ [`GET ${getUrl}`]: () => json({ sha: "sha-1", content: b64({ title: "About", sections: [] }) }) }),
    );

    await expect(
      websiteModule.handle({ intent: "website.addPage", payload: { slug: "about", title: "About v2" } }, ctx()),
    ).rejects.toThrow(/page "about" already exists/);
  });

  it("website.addPage creates a new page with no SHA and triggers the rebuild webhook", async () => {
    process.env.JARVIS_WEBSITE_REBUILD_URL = "http://website:8080/internal/rebuild";
    const getUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/src/content/pages/mobs.json?ref=main`;
    const putUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/src/content/pages/mobs.json`;
    let putBody: Record<string, unknown> | undefined;
    let rebuildCalled = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        if (method === "GET" && url === getUrl) return json({ message: "Not Found" }, 404);
        if (method === "PUT" && url === putUrl) {
          putBody = JSON.parse(String(init?.body));
          return json({ content: { sha: "sha-new" } });
        }
        if (method === "POST" && url === process.env.JARVIS_WEBSITE_REBUILD_URL) {
          rebuildCalled = true;
          return new Response(null, { status: 200 });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    const result = await websiteModule.handle(
      { intent: "website.addPage", payload: { slug: "mobs", title: "Our Mobs", sections: {} } },
      ctx(),
    );

    expect(result).toEqual({ created: true, page: "mobs", rebuildTriggered: true });
    expect(putBody?.sha).toBeUndefined();
    expect(rebuildCalled).toBe(true);
  });

  it("website.replacePhoto requires an attached image on the current turn", async () => {
    await expect(
      websiteModule.handle({ intent: "website.replacePhoto", payload: { path: "about/family.jpg" } }, ctx({ attachments: [] })),
    ).rejects.toThrow(/requires the user to have attached an image/);
  });

  it("website.replacePhoto rejects a non-image attachment rather than guessing it's fine", async () => {
    await expect(
      websiteModule.handle(
        { intent: "website.replacePhoto", payload: { path: "about/family.jpg" } },
        ctx({ attachments: [{ mediaType: "application/pdf", base64Data: "AAAA" }] }),
      ),
    ).rejects.toThrow(/not an image/);
  });

  it("website.replacePhoto writes the attached image's raw base64 straight to the photos dir", async () => {
    const photoPath = "about/family.jpg";
    const getUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/public/photos/${photoPath}?ref=main`;
    const putUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/public/photos/${photoPath}`;
    let putBody: Record<string, unknown> | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        if (method === "GET" && url === getUrl) return json({ message: "Not Found" }, 404);
        if (method === "PUT" && url === putUrl) {
          putBody = JSON.parse(String(init?.body));
          return json({ content: { sha: "sha-photo" } });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    const result = await websiteModule.handle(
      { intent: "website.replacePhoto", payload: { path: photoPath, attachmentIndex: 0 } },
      ctx({ attachments: [{ mediaType: "image/jpeg", base64Data: "ZmFrZS1qcGVn", filename: "family.jpg" }] }),
    );

    expect(result).toEqual({ replaced: true, path: photoPath, rebuildTriggered: false });
    expect(putBody?.content).toBe("ZmFrZS1qcGVn"); // passed through untouched, no re-encoding
    expect(putBody?.sha).toBeUndefined();
  });

  it("website.listContent summarizes every page's title and section keys", async () => {
    const dirUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/src/content/pages?ref=main`;
    const aboutUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/src/content/pages/about.json?ref=main`;
    const aboutPage = { title: "About", sections: [{ key: "intro", body: "hi" }] };

    vi.stubGlobal(
      "fetch",
      fakeFetch({
        [`GET ${dirUrl}`]: () => json([{ name: "about.json" }, { name: "README.md" }]),
        [`GET ${aboutUrl}`]: () => json({ sha: "sha-1", content: b64(aboutPage) }),
      }),
    );

    const result = await websiteModule.handle({ intent: "website.listContent", payload: {} }, ctx());
    expect(result).toEqual({ pages: [{ slug: "about", title: "About", sections: ["intro"] }] });
  });
});
