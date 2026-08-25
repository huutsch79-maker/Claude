import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";

const exec = promisify(execFile);

const REPO = process.env.WEBSITE_GITHUB_REPO; // "owner/repo"
const BRANCH = process.env.WEBSITE_GITHUB_BRANCH || "main";
const TOKEN = process.env.WEBSITE_GITHUB_TOKEN;
const PORT = process.env.PORT || 8080;
const INTERNAL_PORT = process.env.INTERNAL_PORT || 8081;
const SITE_DIR = process.env.WEBSITE_SITE_DIR || "/data/site";
const DIST_DIR = path.join(SITE_DIR, "dist");

if (!REPO || !TOKEN) {
  console.error("website-server: WEBSITE_GITHUB_REPO and WEBSITE_GITHUB_TOKEN are both required — refusing to start.");
  process.exit(1);
}

// The token is embedded in the clone/fetch URL only — never logged, never
// written to a file other than git's own remote config inside SITE_DIR
// (a volume, not something baked into the image).
const remoteUrl = `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;

async function pullAndBuild() {
  if (existsSync(path.join(SITE_DIR, ".git"))) {
    console.log("website-server: pulling latest content...");
    await exec("git", ["-C", SITE_DIR, "fetch", "--depth", "1", "origin", BRANCH]);
    await exec("git", ["-C", SITE_DIR, "reset", "--hard", `origin/${BRANCH}`]);
  } else {
    console.log("website-server: cloning content repo...");
    await exec("git", ["clone", "--branch", BRANCH, "--depth", "1", remoteUrl, SITE_DIR]);
  }
  console.log("website-server: installing dependencies...");
  await exec("npm", ["ci"], { cwd: SITE_DIR });
  console.log("website-server: building site...");
  await exec("npm", ["run", "build"], { cwd: SITE_DIR });
  console.log("website-server: build complete.");
}

// Concurrent rebuild requests join the same in-flight build instead of
// racing each other over the same working directory; the lock clears once
// it settles (success or failure) so the next call starts a fresh build.
let inFlight = null;
function rebuild() {
  if (!inFlight) {
    inFlight = pullAndBuild().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

// Serves the built static site. This is the only listener the Cloudflare
// Tunnel's public hostname should ever point at.
const publicApp = express();
publicApp.use(express.static(DIST_DIR));
publicApp.listen(PORT, () => console.log(`website-server: serving ${DIST_DIR} on :${PORT}`));

// Deliberately a second, separate listener rather than a route on the
// public app: this port is never published to the host and never given a
// Cloudflare Tunnel hostname, so it's reachable only from other containers
// on the same docker-compose network (i.e. the orchestrator). That network
// boundary is the endpoint's actual security, not an auth check — same
// reasoning db's 127.0.0.1-only bind in docker-compose.yml relies on.
const internalApp = express();
internalApp.post("/internal/rebuild", async (_req, res) => {
  try {
    await rebuild();
    res.json({ ok: true });
  } catch (err) {
    console.error("website-server: rebuild failed:", err);
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
internalApp.get("/healthz", (_req, res) => res.json({ ok: true, building: inFlight !== null }));
internalApp.listen(INTERNAL_PORT, () => console.log(`website-server: internal rebuild endpoint on :${INTERNAL_PORT}`));

rebuild().catch((err) => console.error("website-server: initial build failed (will retry on the next rebuild call):", err));
