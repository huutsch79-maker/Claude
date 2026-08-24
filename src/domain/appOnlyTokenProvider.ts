import { ClientSecretCredential } from "@azure/identity";

interface AppOnlyCredentialConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * App-only (client-credentials) token acquisition for the two read-only
 * tenant-insight capabilities — see docs/architecture.md's "Tenant
 * insights: read-only by design". Unlike the raw-bearer-token stub the
 * other capabilities use, these need a real, auto-refreshing OAuth token
 * because Graph and Azure Resource Manager tokens expire in ~1 hour.
 *
 * The credential_ref's env value is a JSON object (tenantId/clientId/
 * clientSecret), not a raw token — the capability owns how it interprets
 * its own credential value; CredentialStore itself stays a plain opaque
 * string store. ClientSecretCredential instances are cached per
 * tenant+client (not per call) because @azure/identity's own MSAL layer
 * caches and refreshes tokens internally on a reused instance.
 */
const credentialCache = new Map<string, ClientSecretCredential>();

function parseConfig(raw: string): AppOnlyCredentialConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('expected credential value to be JSON: {"tenantId":"...","clientId":"...","clientSecret":"..."}');
  }
  const c = parsed as Partial<AppOnlyCredentialConfig>;
  if (!c.tenantId || !c.clientId || !c.clientSecret) {
    throw new Error("credential JSON must include tenantId, clientId, and clientSecret");
  }
  return { tenantId: c.tenantId, clientId: c.clientId, clientSecret: c.clientSecret };
}

export async function getAppOnlyAccessToken(rawCredentialValue: string, scope: string): Promise<string> {
  const config = parseConfig(rawCredentialValue);
  const cacheKey = `${config.tenantId}:${config.clientId}`;
  let credential = credentialCache.get(cacheKey);
  if (!credential) {
    credential = new ClientSecretCredential(config.tenantId, config.clientId, config.clientSecret);
    credentialCache.set(cacheKey, credential);
  }
  const token = await credential.getToken(scope);
  if (!token) throw new Error(`failed to acquire an access token for scope "${scope}"`);
  return token.token;
}
