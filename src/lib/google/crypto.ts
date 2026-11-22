import "server-only";

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Google tokens are encrypted before they reach the database, with a key
 * derived from GOOGLE_CLIENT_SECRET. One less secret to manage: if the
 * client secret is rotated, old tokens stop decrypting and the user
 * reconnects once.
 */

const VERSION = "v1";

function key(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "whitespace-google", "token-encryption", 32));
}

export function encryptToken(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, body]).toString("base64")}`;
}

/** Null when the value is not ours or the secret changed. */
export function decryptToken(sealed: string, secret: string): string | null {
  const [version, payload] = sealed.split(":", 2);
  if (version !== VERSION || !payload) return null;
  try {
    const raw = Buffer.from(payload, "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const body = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
