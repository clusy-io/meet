import "server-only";
import { getMeetConfig } from "./config";
import { secretEquals, sign, verifySigned } from "./crypto";

/**
 * clusy/meet: admin gate.
 *
 * Two credentials open /admin: the raw secret as a Bearer header (for
 * curl and scripts) or a signed timestamp cookie issued by the login route.
 * Mock mode skips the gate entirely so local demos need no secrets.
 * Server-only.
 */

export const ADMIN_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-meet_admin" : "meet_admin";

/** Cookie lifetime; matches the Max-Age the login route sets (30 days). */
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function requireAdmin(request: Request): boolean {
  const config = getMeetConfig();
  if (config.mockMode) return true;
  // Without a configured secret there is nothing to compare against; the
  // admin surface stays closed rather than open.
  if (!config.adminSecret) return false;

  const auth = request.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) {
    if (secretEquals(auth.slice("Bearer ".length), config.adminSecret)) return true;
  }

  const raw = readCookie(request.headers.get("cookie"), ADMIN_COOKIE);
  if (!raw) return false;
  try {
    const payload = verifySigned(raw);
    if (payload === null) return false;
    const issuedAtMs = Number(payload);
    if (!Number.isFinite(issuedAtMs)) return false;
    return Date.now() - issuedAtMs < COOKIE_MAX_AGE_MS;
  } catch {
    // MEET_TOKEN_SECRET unset: signed cookies cannot be verified.
    return false;
  }
}

/** Signed issue-timestamp; requireAdmin accepts it for 30 days. */
export function adminCookieValue(): string {
  return sign(String(Date.now()));
}
