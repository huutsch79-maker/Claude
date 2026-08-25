import type { CapabilityContext, CapabilityModule } from "../../domain/capabilityRegistry.js";
import { describeFailedResponse } from "../../domain/httpError.js";

export interface EmailRequest {
  intent: "email.search" | "email.send";
  payload: Record<string, unknown>;
}

/**
 * Hotmail/Outlook via Microsoft Graph, real delegated OAuth (see
 * src/domain/oauthCredentialStore.ts) — connect from the dashboard's
 * Capabilities section once JARVIS_OAUTH_APP_HOTMAIL_OAUTH is configured.
 *
 * An IMAP/SMTP + app-password version of this module was tried first, to
 * avoid needing an Entra app registration for a personal mailbox at all.
 * It turned out not to work: Microsoft rejects the app-password IMAP
 * login outright ("Login is disabled") — Basic Authentication is being
 * phased out across both organizational and consumer accounts, not just
 * business tenants as originally assumed. So this is back to Graph OAuth,
 * same mechanism nzb-m365-connector already uses.
 */
const hotmailModule: CapabilityModule = {
  canHandle(request: unknown): boolean {
    const req = request as Partial<EmailRequest>;
    return req?.intent === "email.search" || req?.intent === "email.send";
  },

  async handle(request: unknown, ctx: CapabilityContext): Promise<unknown> {
    const req = request as EmailRequest;
    if (!ctx.credential) {
      throw new Error(
        "hotmail-outlook: no credential configured. Connect this capability from the dashboard's Capabilities " +
          "section (requires JARVIS_OAUTH_APP_HOTMAIL_OAUTH to be set) before using it.",
      );
    }

    const graphBase = "https://graph.microsoft.com/v1.0";
    if (req.intent === "email.search") {
      const query = typeof req.payload.query === "string" ? req.payload.query : "";
      const response = await fetch(`${graphBase}/me/messages?$search="${encodeURIComponent(query)}"`, {
        headers: { authorization: `Bearer ${ctx.credential.value}` },
      });
      if (!response.ok) throw new Error(`hotmail-outlook: Graph search failed (${await describeFailedResponse(response)})`);
      return response.json();
    }

    // email.send
    const response = await fetch(`${graphBase}/me/sendMail`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.credential.value}`, "content-type": "application/json" },
      body: JSON.stringify({ message: req.payload }),
    });
    if (!response.ok) throw new Error(`hotmail-outlook: Graph sendMail failed (${await describeFailedResponse(response)})`);
    return { sent: true };
  },
};

export default hotmailModule;
