import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { getMeetConfig } from "./config";

/**
 * clusy/meet — token encryption and signing.
 *
 * Refresh tokens are AES-256-GCM encrypted at rest with MEET_TOKEN_SECRET.
 * OAuth state blobs and admin cookies are HMAC-signed with the same secret.
 * Node "crypto" only — server-side modules exclusively.
 */

function keyBytes(): Buffer {
  const secret = getMeetConfig().tokenSecret;
  if (!secret || secret.length < 32) {
    throw new Error("meet: MEET_TOKEN_SECRET is not set (32+ chars required)");
  }
  // Domain-separate and stretch to exactly 32 bytes via HMAC.
  return createHmac("sha256", "clusy-meet-key-v1").update(secret).digest();
}

/** ciphertext format: v1.<iv b64url>.<tag b64url>.<data b64url> */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${data.toString("base64url")}`;
}

export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("meet: unrecognized ciphertext format");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Unguessable, URL-safe token (bookings' manage token). */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/** payload -> "payload.sig" (payload must be base64url-safe already). */
export function sign(payload: string): string {
  const sig = createHmac("sha256", keyBytes()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Verify "payload.sig"; returns payload or null. */
export function verifySigned(value: string): string | null {
  const idx = value.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  const expected = createHmac("sha256", keyBytes()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return payload;
}

/** Constant-time string comparison for the admin secret. */
export function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
