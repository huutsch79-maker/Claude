import type { CapabilityContext, CapabilityModule } from "../../domain/capabilityRegistry.js";

export interface EmailRequest {
  intent: "email.search" | "email.send";
  payload: Record<string, unknown>;
}

/**
 * Hotmail/Outlook via Microsoft Graph. Proves the dynamic-module pattern
 * from CLAUDE.md — one of the two starter connectors, alongside the NZB
 * connector.
 *
 * The OAuth exchange itself is intentionally stubbed: wiring a live
 * Microsoft Graph app registration is an operational step for whoever
 * runs this, not something to fake here.
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
        "hotmail-outlook: no credential configured. Set JARVIS_CRED_HOTMAIL_OAUTH " +
          "(and complete the Microsoft Graph OAuth flow) before using this capability.",
      );
    }

    const graphBase = "https://graph.microsoft.com/v1.0";
    if (req.intent === "email.search") {
      const query = typeof req.payload.query === "string" ? req.payload.query : "";
      const response = await fetch(`${graphBase}/me/messages?$search="${encodeURIComponent(query)}"`, {
        headers: { authorization: `Bearer ${ctx.credential.value}` },
      });
      if (!response.ok) throw new Error(`hotmail-outlook: Graph search failed (${response.status})`);
      return response.json();
    }

    // email.send
    const response = await fetch(`${graphBase}/me/sendMail`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.credential.value}`, "content-type": "application/json" },
      body: JSON.stringify({ message: req.payload }),
    });
    if (!response.ok) throw new Error(`hotmail-outlook: Graph sendMail failed (${response.status})`);
    return { sent: true };
  },
};

export default hotmailModule;
