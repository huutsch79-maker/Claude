import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { CapabilityContext, CapabilityModule } from "../../domain/capabilityRegistry.js";

export interface EmailRequest {
  intent: "email.search" | "email.send";
  payload: Record<string, unknown>;
}

interface HotmailImapCredential {
  email: string;
  appPassword: string;
}

const IMAP_HOST = "outlook.office365.com";
const IMAP_PORT = 993;
const SMTP_HOST = "smtp-mail.outlook.com";
const SMTP_PORT = 587;
const MAX_RESULTS = 20;

function parseCredential(raw: string): HotmailImapCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('hotmail-outlook: expected credential JSON {"email":"...","appPassword":"..."}');
  }
  const c = parsed as Partial<HotmailImapCredential>;
  if (!c.email || !c.appPassword) {
    throw new Error("hotmail-outlook: credential JSON must include email and appPassword");
  }
  return { email: c.email, appPassword: c.appPassword };
}

/**
 * Personal Hotmail/Outlook.com via IMAP (search) and SMTP (send), both
 * authenticated with an account app password — not Graph OAuth. See
 * manifest.ts for why: this is a personal mailbox with no connection to
 * any employer's Entra tenant, and an app password sidesteps needing an
 * Entra app registration (and the tenant-hosting question that comes with
 * one) entirely for this specific capability.
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
        "hotmail-outlook: no credential configured. Set JARVIS_CRED_HOTMAIL_IMAP to " +
          '{"email":"...","appPassword":"..."} — generate the app password at ' +
          "https://account.live.com/proofs/AppPassword (requires two-step verification enabled on the account) " +
          "before using this capability.",
      );
    }
    const { email, appPassword } = parseCredential(ctx.credential.value);

    if (req.intent === "email.search") {
      const query = typeof req.payload.query === "string" ? req.payload.query : "";
      return searchMessages(email, appPassword, query);
    }

    return sendMessage(email, appPassword, req.payload);
  },
};

async function searchMessages(email: string, appPassword: string, query: string): Promise<unknown> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: email, pass: appPassword },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search(query ? { text: query } : { all: true }, { uid: true });
      const recent = (uids || []).slice(-MAX_RESULTS).reverse();
      const messages: Array<{ subject: string; from: string; date: string | null }> = [];
      for await (const msg of client.fetch(recent, { envelope: true })) {
        messages.push({
          subject: msg.envelope?.subject ?? "(no subject)",
          from: msg.envelope?.from?.[0]?.address ?? "(unknown)",
          date: msg.envelope?.date ? msg.envelope.date.toISOString() : null,
        });
      }
      return { messages };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function sendMessage(email: string, appPassword: string, payload: Record<string, unknown>): Promise<unknown> {
  const to = typeof payload.to === "string" ? payload.to : "";
  const subject = typeof payload.subject === "string" ? payload.subject : "";
  const body = typeof payload.body === "string" ? payload.body : "";
  if (!to) throw new Error("hotmail-outlook: email.send requires payload.to");

  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    requireTLS: true,
    auth: { user: email, pass: appPassword },
  });
  await transport.sendMail({ from: email, to, subject, text: body });
  return { sent: true };
}

export default hotmailModule;
