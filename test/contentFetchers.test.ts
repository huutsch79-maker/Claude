import { describe, expect, it } from "vitest";
import { DOMAINS } from "../src/config/domains.js";
import { CredentialStore } from "../src/domain/credentialStore.js";
import { fetchHotmailSummary } from "../src/modules/personal/hotmail/summary.js";
import { fetchNzbMailSummary } from "../src/modules/work/nzb-connector/summary.js";
import { fetchAzureCostSummary, REQUIRED_ENV_VARS } from "../src/modules/work/nzb-connector/azureCost.js";

/** A /me/messages Graph-API-shaped fixture, matching the real response shape used by both mail fetchers. */
function graphMessagesFixture(senders: { name?: string; address?: string }[]): { value: { from?: { emailAddress?: { name?: string; address?: string } } }[] } {
  return { value: senders.map((s) => ({ from: { emailAddress: { name: s.name, address: s.address } } })) };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Routes a fetchImpl call to a fixed sequence of canned responses, in call order — mirrors the three sequential Graph calls each mail fetcher makes. */
function sequencedFetch(responses: Response[]): typeof fetch {
  let i = 0;
  return (async () => {
    const res = responses[i];
    i += 1;
    if (!res) throw new Error("sequencedFetch: ran out of canned responses");
    return res;
  }) as unknown as typeof fetch;
}

describe("fetchHotmailSummary (personal domain mail connector)", () => {
  it("returns not_configured when JARVIS_PERSONAL_HOTMAIL_OAUTH is unset — never calls fetch", async () => {
    const credentials = new CredentialStore(DOMAINS.personal, {} as NodeJS.ProcessEnv);
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("should never be called");
    }) as unknown as typeof fetch;

    const result = await fetchHotmailSummary(credentials, fetchImpl);
    expect(result).toEqual({ status: "not_configured", unreadCount: 0, totalCount: 0, topSenders: [], lastSyncedAt: null });
    expect(called).toBe(false);
  });

  it("aggregates a connected Graph fixture into a MailSummary, capped/truncated per the shared limits", async () => {
    const env = { JARVIS_PERSONAL_HOTMAIL_OAUTH: "test-token" } as NodeJS.ProcessEnv;
    const credentials = new CredentialStore(DOMAINS.personal, env);
    const fetchImpl = sequencedFetch([
      jsonResponse({ "@odata.count": 7 }), // unread count
      jsonResponse({ "@odata.count": 200 }), // total count
      jsonResponse(
        graphMessagesFixture([
          { name: "Alice" },
          { name: "Alice" },
          { name: "Bob" },
          { address: "carol@example.com" }, // no name — falls back to address
        ]),
      ),
    ]);

    const result = await fetchHotmailSummary(credentials, fetchImpl);
    expect(result.status).toBe("connected");
    expect(result.unreadCount).toBe(7);
    expect(result.totalCount).toBe(200);
    expect(result.topSenders[0]).toEqual({ displayName: "Alice", messageCount: 2 });
    expect(result.topSenders.some((s) => s.displayName === "carol@example.com")).toBe(true);
    expect(typeof result.lastSyncedAt).toBe("string");
  });

  it("returns error (never throws) when a Graph call fails", async () => {
    const env = { JARVIS_PERSONAL_HOTMAIL_OAUTH: "test-token" } as NodeJS.ProcessEnv;
    const credentials = new CredentialStore(DOMAINS.personal, env);
    const fetchImpl = sequencedFetch([jsonResponse({}, false, 401)]);

    const result = await fetchHotmailSummary(credentials, fetchImpl);
    expect(result).toEqual({ status: "error", unreadCount: 0, totalCount: 0, topSenders: [], lastSyncedAt: null });
  });

  it("returns error when the fetch implementation itself throws (network failure)", async () => {
    const env = { JARVIS_PERSONAL_HOTMAIL_OAUTH: "test-token" } as NodeJS.ProcessEnv;
    const credentials = new CredentialStore(DOMAINS.personal, env);
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const result = await fetchHotmailSummary(credentials, fetchImpl);
    expect(result.status).toBe("error");
  });
});

describe("fetchNzbMailSummary (work domain mail connector)", () => {
  it("returns not_configured when JARVIS_WORK_NZB_M365_OAUTH is unset — never calls fetch", async () => {
    const credentials = new CredentialStore(DOMAINS.work, {} as NodeJS.ProcessEnv);
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("should never be called");
    }) as unknown as typeof fetch;

    const result = await fetchNzbMailSummary(credentials, fetchImpl);
    expect(result).toEqual({ status: "not_configured", unreadCount: 0, totalCount: 0, topSenders: [], lastSyncedAt: null });
    expect(called).toBe(false);
  });

  it("aggregates a connected Graph fixture into a MailSummary", async () => {
    const env = { JARVIS_WORK_NZB_M365_OAUTH: "test-token" } as NodeJS.ProcessEnv;
    const credentials = new CredentialStore(DOMAINS.work, env);
    const fetchImpl = sequencedFetch([
      jsonResponse({ "@odata.count": 3 }),
      jsonResponse({ "@odata.count": 50 }),
      jsonResponse(graphMessagesFixture([{ name: "Dave" }, { name: "Dave" }, { name: "Dave" }])),
    ]);

    const result = await fetchNzbMailSummary(credentials, fetchImpl);
    expect(result.status).toBe("connected");
    expect(result.unreadCount).toBe(3);
    expect(result.totalCount).toBe(50);
    expect(result.topSenders).toEqual([{ displayName: "Dave", messageCount: 3 }]);
  });

  it("returns error (never throws) when a Graph call fails", async () => {
    const env = { JARVIS_WORK_NZB_M365_OAUTH: "test-token" } as NodeJS.ProcessEnv;
    const credentials = new CredentialStore(DOMAINS.work, env);
    const fetchImpl = sequencedFetch([jsonResponse({ "@odata.count": 1 }), jsonResponse({}, false, 500)]);

    const result = await fetchNzbMailSummary(credentials, fetchImpl);
    expect(result.status).toBe("error");
  });

  it("work and personal mail fetchers are independently gated — setting only one domain's credential never satisfies the other", async () => {
    const env = { JARVIS_WORK_NZB_M365_OAUTH: "work-token" } as NodeJS.ProcessEnv;
    const workCredentials = new CredentialStore(DOMAINS.work, env);
    const personalCredentials = new CredentialStore(DOMAINS.personal, env);

    let workFetchCalled = false;
    const workFetch = sequencedFetch([jsonResponse({ "@odata.count": 0 }), jsonResponse({ "@odata.count": 0 }), jsonResponse(graphMessagesFixture([]))]);
    const wrappedWorkFetch = (async (...args: Parameters<typeof fetch>) => {
      workFetchCalled = true;
      return workFetch(...args);
    }) as unknown as typeof fetch;

    let personalFetchCalled = false;
    const personalFetch = (async () => {
      personalFetchCalled = true;
      throw new Error("should never be called — personal credential is not set");
    }) as unknown as typeof fetch;

    const workResult = await fetchNzbMailSummary(workCredentials, wrappedWorkFetch);
    const personalResult = await fetchHotmailSummary(personalCredentials, personalFetch);

    expect(workResult.status).toBe("connected");
    expect(workFetchCalled).toBe(true);
    expect(personalResult.status).toBe("not_configured");
    expect(personalFetchCalled).toBe(false);
  });
});

describe("fetchAzureCostSummary (work domain Azure Cost Management connector)", () => {
  it("returns not_configured unless all four required env vars are set — never calls fetch", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("should never be called");
    }) as unknown as typeof fetch;

    for (const missing of REQUIRED_ENV_VARS) {
      const env: Record<string, string> = {
        JARVIS_WORK_AZURE_TENANT_ID: "t",
        JARVIS_WORK_AZURE_CLIENT_ID: "c",
        JARVIS_WORK_AZURE_CLIENT_SECRET: "s",
        JARVIS_WORK_AZURE_SUBSCRIPTION_ID: "sub",
      };
      delete env[missing];
      const result = await fetchAzureCostSummary(env as NodeJS.ProcessEnv, fetchImpl);
      expect(result.status).toBe("not_configured");
    }
    expect(called).toBe(false);
  });

  it("aggregates a connected Cost Management Query fixture, grouped by ServiceName", async () => {
    const env = {
      JARVIS_WORK_AZURE_TENANT_ID: "t",
      JARVIS_WORK_AZURE_CLIENT_ID: "c",
      JARVIS_WORK_AZURE_CLIENT_SECRET: "s",
      JARVIS_WORK_AZURE_SUBSCRIPTION_ID: "sub",
    } as NodeJS.ProcessEnv;

    const fetchImpl = sequencedFetch([
      jsonResponse({ access_token: "arm-token" }), // token acquisition
      jsonResponse({
        properties: {
          columns: [{ name: "Cost" }, { name: "ServiceName" }, { name: "Currency" }],
          rows: [
            [12.5, "Storage", "USD"],
            [7.5, "Storage", "USD"],
            [30.0, "Compute", "USD"],
          ],
        },
      }),
    ]);

    const result = await fetchAzureCostSummary(env, fetchImpl);
    expect(result.status).toBe("connected");
    expect(result.currency).toBe("USD");
    expect(result.monthToDateCost).toBeCloseTo(50.0);
    expect(result.topServices[0]).toEqual({ serviceName: "Compute", cost: 30.0 });
    expect(result.topServices.find((s) => s.serviceName === "Storage")?.cost).toBeCloseTo(20.0);
  });

  it("returns error (never throws) when token acquisition fails", async () => {
    const env = {
      JARVIS_WORK_AZURE_TENANT_ID: "t",
      JARVIS_WORK_AZURE_CLIENT_ID: "c",
      JARVIS_WORK_AZURE_CLIENT_SECRET: "s",
      JARVIS_WORK_AZURE_SUBSCRIPTION_ID: "sub",
    } as NodeJS.ProcessEnv;
    const fetchImpl = sequencedFetch([jsonResponse({}, false, 401)]);

    const result = await fetchAzureCostSummary(env, fetchImpl);
    expect(result).toEqual({ status: "error", currency: "USD", monthToDateCost: null, topServices: [], lastSyncedAt: null });
  });

  it("returns error (never throws) when the cost query itself fails", async () => {
    const env = {
      JARVIS_WORK_AZURE_TENANT_ID: "t",
      JARVIS_WORK_AZURE_CLIENT_ID: "c",
      JARVIS_WORK_AZURE_CLIENT_SECRET: "s",
      JARVIS_WORK_AZURE_SUBSCRIPTION_ID: "sub",
    } as NodeJS.ProcessEnv;
    const fetchImpl = sequencedFetch([jsonResponse({ access_token: "arm-token" }), jsonResponse({}, false, 500)]);

    const result = await fetchAzureCostSummary(env, fetchImpl);
    expect(result.status).toBe("error");
  });

  it("reads its four env vars directly, not via CredentialStore — an explicit, documented deviation (see azureCost.ts header comment)", () => {
    expect(REQUIRED_ENV_VARS).toEqual([
      "JARVIS_WORK_AZURE_TENANT_ID",
      "JARVIS_WORK_AZURE_CLIENT_ID",
      "JARVIS_WORK_AZURE_CLIENT_SECRET",
      "JARVIS_WORK_AZURE_SUBSCRIPTION_ID",
    ]);
  });
});
