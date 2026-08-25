import { describeFailedResponse } from "./httpError.js";

const GITHUB_API = "https://api.github.com";

export interface GithubRepoRef {
  owner: string;
  repo: string;
  branch: string;
}

/**
 * Shared by the farm-website capability module and the apply-website-file
 * bounded script (scriptRegistry.ts) — both read/write the same content
 * repo via GitHub's Contents API, so the fetch/base64 plumbing lives here
 * once instead of twice.
 */
export function websiteRepoRef(): GithubRepoRef {
  const full = process.env.JARVIS_WEBSITE_GITHUB_REPO ?? "";
  const [owner, repo] = full.split("/");
  if (!owner || !repo) {
    throw new Error('JARVIS_WEBSITE_GITHUB_REPO is not set to an "owner/repo" value — cannot reach the content repo.');
  }
  return { owner, repo, branch: process.env.JARVIS_WEBSITE_GITHUB_BRANCH || "main" };
}

export async function getFile(ref: GithubRepoRef, path: string, token: string): Promise<{ sha: string; contentBase64: string } | null> {
  const response = await fetch(
    `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/contents/${path}?ref=${encodeURIComponent(ref.branch)}`,
    { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub read of "${path}" failed (${await describeFailedResponse(response)})`);
  const body = (await response.json()) as { sha: string; content: string };
  return { sha: body.sha, contentBase64: body.content.replace(/\n/g, "") };
}

export async function putFile(
  ref: GithubRepoRef,
  path: string,
  contentBase64: string,
  message: string,
  sha: string | undefined,
  token: string,
): Promise<void> {
  const response = await fetch(`${GITHUB_API}/repos/${ref.owner}/${ref.repo}/contents/${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    body: JSON.stringify({ message, content: contentBase64, branch: ref.branch, ...(sha ? { sha } : {}) }),
  });
  if (!response.ok) throw new Error(`GitHub write of "${path}" failed (${await describeFailedResponse(response)})`);
}

export async function listDir(ref: GithubRepoRef, path: string, token: string): Promise<Array<{ name: string }>> {
  const response = await fetch(
    `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/contents/${path}?ref=${encodeURIComponent(ref.branch)}`,
    { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
  );
  if (!response.ok) throw new Error(`GitHub directory listing of "${path}" failed (${await describeFailedResponse(response)})`);
  return (await response.json()) as Array<{ name: string }>;
}
