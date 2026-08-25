import type pg from "pg";
import type { CredentialRecord } from "./credentialStore.js";
import { describeFailedResponse } from "./httpError.js";

interface OAuthAppConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

const OAUTH_APP_ENV_PREFIX = "JARVIS_OAUTH_APP_";
const AUTHORIZE_STATE_TTL_MS = 10 * 60 * 1000; // 10 min to complete the Microsoft consent screen
const REFRESH_MARGIN_MS = 60_000; // refresh a bit before actual expiry, not exactly at it

function envKey(ref: string): string {
  return `${OAUTH_APP_ENV_PREFIX}${ref.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * Real interactive OAuth (authorization-code + refresh-token) for the
 * capabilities that need actual delegated consent — Hotmail, the NZB
 * connector's mail scopes — as opposed to the static JARVIS_CRED_* values
 * everything else uses. This is deliberately a separate store from
 * CredentialStore: those are read-only env values, these are dynamic,
 * DB-persisted, and self-refreshing. See docs/architecture.md's
 * "Delegated OAuth" section for the full flow and why the human always
 * has to be the one who completes the Microsoft consent screen — nothing
 * here can obtain a token without that step.
 */
export class OAuthCredentialStore {
  private readonly pendingStates = new Map<string, { ref: string; createdAt: number }>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly redirectBaseUrl: string,
  ) {}

  private appConfig(ref: string): OAuthAppConfig | null {
    const raw = process.env[envKey(ref)];
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<OAuthAppConfig>;
      if (!parsed.tenantId || !parsed.clientId || !parsed.clientSecret || !Array.isArray(parsed.scopes)) return null;
      return parsed as OAuthAppConfig;
    } catch {
      return null;
    }
  }

  private redirectUri(): string {
    return `${this.redirectBaseUrl}/api/oauth/callback`;
  }

  /** Whether this ref has an OAuth app configured at all — lets the dashboard decide whether to show "Connect." */
  isConfigured(ref: string): boolean {
    return this.appConfig(ref) !== null;
  }

  /**
   * Issues a one-time, short-lived state token and returns the URL to send
   * the browser to. The state is what makes the later callback trustworthy
   * — Microsoft's redirect back has no bearer token on it, so the state
   * (unguessable, single-use, tied to this specific ref, expires in 10
   * min) is the only thing standing between "a real consent flow this
   * dashboard started" and a forged callback.
   */
  buildAuthorizeUrl(ref: string): string | null {
    const config = this.appConfig(ref);
    if (!config) return null;
    const state = crypto.randomUUID();
    this.pendingStates.set(state, { ref, createdAt: Date.now() });
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: this.redirectUri(),
      response_mode: "query",
      scope: [...config.scopes, "offline_access"].join(" "),
      state,
    });
    return `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  /** Called by the dashboard's /api/oauth/callback route once Microsoft redirects back with a code. */
  async completeAuthorization(state: string, code: string): Promise<{ ref: string }> {
    const pending = this.pendingStates.get(state);
    this.pendingStates.delete(state); // single-use regardless of outcome
    if (!pending) throw new Error("invalid or expired OAuth state — start the connection again from the dashboard");
    if (Date.now() - pending.createdAt > AUTHORIZE_STATE_TTL_MS) {
      throw new Error("OAuth state expired (10 min) — start the connection again from the dashboard");
    }
    await this.exchangeCode(pending.ref, code);
    return { ref: pending.ref };
  }

  private async exchangeCode(ref: string, code: string): Promise<void> {
    const config = this.appConfig(ref);
    if (!config) throw new Error(`no OAuth app configured for "${ref}" (expected ${envKey(ref)})`);
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri(),
      scope: [...config.scopes, "offline_access"].join(" "),
    });
    const response = await fetch(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error(`token exchange failed (${await describeFailedResponse(response)})`);
    const tokens = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string };
    await this.persist(ref, tokens.access_token, tokens.refresh_token, tokens.expires_in, tokens.scope);
  }

  private async persist(ref: string, accessToken: string, refreshToken: string, expiresInSeconds: number, scope: string): Promise<void> {
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    await this.pool.query(
      `insert into jarvis.oauth_credentials (credential_ref, access_token, refresh_token, expires_at, scope)
       values ($1, $2, $3, $4, $5)
       on conflict (credential_ref) do update set
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at,
         scope = excluded.scope,
         updated_at = now()`,
      [ref, accessToken, refreshToken, expiresAt, scope],
    );
  }

  /**
   * Returns a currently-valid access token for `ref`, refreshing it first
   * if it's near expiry. Returns null if this ref was never connected (no
   * row) or the refresh itself failed (e.g. the user revoked consent in
   * Microsoft) — either way, the caller falls through to treating this as
   * "no credential configured," same as before this feature existed.
   */
  async getValidToken(ref: string): Promise<CredentialRecord | null> {
    const result = await this.pool.query(
      `select access_token, refresh_token, expires_at from jarvis.oauth_credentials where credential_ref = $1`,
      [ref],
    );
    const row = result.rows[0] as { access_token: string; refresh_token: string; expires_at: string } | undefined;
    if (!row) return null;

    const expiresAtMs = new Date(row.expires_at).getTime();
    if (expiresAtMs - Date.now() > REFRESH_MARGIN_MS) {
      return { ref, value: row.access_token, expiresAt: row.expires_at };
    }
    return this.refresh(ref, row.refresh_token);
  }

  private async refresh(ref: string, refreshToken: string): Promise<CredentialRecord | null> {
    const config = this.appConfig(ref);
    if (!config) return null;
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: [...config.scopes, "offline_access"].join(" "),
    });
    const response = await fetch(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) return null; // e.g. consent revoked — capability reports "no credential configured" as before
    const tokens = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
    // Microsoft doesn't always rotate the refresh token — keep the old one if none came back.
    const nextRefreshToken = tokens.refresh_token ?? refreshToken;
    await this.persist(ref, tokens.access_token, nextRefreshToken, tokens.expires_in, tokens.scope);
    return { ref, value: tokens.access_token, expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString() };
  }
}
