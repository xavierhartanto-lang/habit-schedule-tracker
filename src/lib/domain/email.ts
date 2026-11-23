/**
 * A single new email. No inbox, no threads, no attachments.
 * Pure checks only: the card shows the result, and nothing is sent here.
 */

const ADDRESS = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export type OutgoingEmail = { to: string; subject: string; body: string };

/** The one address in `value`, or null when there isn't exactly one. */
export function cleanEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const found = value.match(ADDRESS);
  if (!found || found.length !== 1) return null;
  const address = found[0].toLowerCase();
  return address.length <= 254 ? address : null;
}

function oneLine(value: string, max: number): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A subject from what the user asked, never a blank line. */
export function emailSubject(title: string | null | undefined, body: string): string {
  const fromTitle = title ? oneLine(title, 200) : "";
  if (fromTitle) return fromTitle;
  const line = oneLine(body.split(/\n/)[0] ?? "", 80);
  return line || "Note";
}

export function validateOutgoingEmail(raw: { to?: unknown; subject?: unknown; body?: unknown }):
  | { ok: true; value: OutgoingEmail }
  | { ok: false; error: string } {
  const to = typeof raw.to === "string" ? cleanEmail(raw.to) : null;
  if (!to) return { ok: false, error: "Use one email address." };
  const subject = typeof raw.subject === "string" ? oneLine(raw.subject, 200) : "";
  if (!subject) return { ok: false, error: "The email needs a subject." };
  const body = typeof raw.body === "string" ? raw.body.replace(/\r\n/g, "\n").trim() : "";
  if (!body) return { ok: false, error: "The email needs a message." };
  if (body.length > 4000) return { ok: false, error: "Keep the email under 4,000 characters." };
  return { ok: true, value: { to, subject, body } };
}

/** RFC 5322 message, base64url, ready for Gmail's send API. */
export function rawEmail(email: OutgoingEmail): string {
  const subject = /^[\t\x20-\x7E]*$/.test(email.subject)
    ? email.subject
    : `=?UTF-8?B?${Buffer.from(email.subject, "utf8").toString("base64")}?=`;
  const text = [
    `To: ${email.to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    email.body.replace(/\n/g, "\r\n"),
  ].join("\r\n");
  return Buffer.from(text, "utf8").toString("base64url");
}
