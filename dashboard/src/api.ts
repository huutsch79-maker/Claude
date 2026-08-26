let token = localStorage.getItem("jarvis_dashboard_token") || "";

export function getToken(): string {
  return token;
}

export function setToken(next: string): void {
  token = next;
  localStorage.setItem("jarvis_dashboard_token", next);
}

function authHeaders(): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

export class ApiError extends Error {}

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...authHeaders(), ...(opts.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    // res.statusText is unreliable (HTTP/2 responses — e.g. via Cloudflare —
    // have no reason phrase, so browsers report it as ""), so always fall
    // back to the numeric status rather than risking a blank error.
    throw new ApiError(body.error || res.statusText || `HTTP ${res.status}`);
  }
  return res.status === 204 ? (null as T) : ((await res.json()) as T);
}
