import "server-only";

import { DataValidationError } from "@/lib/db/client";
import { getGoogleConnection } from "@/lib/db/google";
import type { OutgoingEmail } from "@/lib/domain/email";
import { validateOutgoingEmail } from "@/lib/domain/email";
import { GoogleApiError, GoogleAuthError, GoogleForbiddenError, getGoogleConfig, sendGmailMessage } from "@/lib/google/api";
import { accessToken } from "./client";

/**
 * Sends one email the user already reviewed. Never called while a card
 * is still waiting. Does not read the inbox.
 */
export async function sendApprovedEmail(userId: string, raw: { to?: unknown; subject?: unknown; body?: unknown }): Promise<OutgoingEmail> {
  const email = validateOutgoingEmail(raw);
  if (!email.ok) throw new DataValidationError(email.error);
  const config = getGoogleConfig();
  if (!config) throw new DataValidationError("Google isn't set up on this server yet. Nothing was sent.");
  const conn = await getGoogleConnection(userId);
  if (!conn) throw new DataValidationError("Connect Google in Settings before sending email. Nothing was sent.");
  if (conn.can_send !== true) {
    throw new DataValidationError("Reconnect Google in Settings and allow sending email. Nothing was sent.");
  }
  try {
    const token = await accessToken(userId, conn, config, new Date());
    await sendGmailMessage(token, email.value);
  } catch (e) {
    if (e instanceof GoogleAuthError) throw new DataValidationError("Google access expired. Reconnect in Settings. Nothing was sent.");
    if (e instanceof GoogleForbiddenError) throw new DataValidationError("Google didn't allow sending. Reconnect and allow email. Nothing was sent.");
    if (e instanceof GoogleApiError) throw new DataValidationError("Gmail didn't accept the email. Nothing was sent.");
    throw e;
  }
  return email.value;
}
