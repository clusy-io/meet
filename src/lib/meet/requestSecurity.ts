/**
 * Browser mutations must originate from the same site. Requests without an
 * Origin remain available to authenticated scripts/curl; browsers attach one
 * to cross-site POST/PATCH/DELETE requests and Sec-Fetch-Site provides a
 * second signal.
 */
export function hasTrustedMutationOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const candidate = new URL(origin).origin;
    const requestUrl = new URL(request.url);
    const trusted = new Set([requestUrl.origin]);
    // Next/Vercel may normalize request.url to its internal hostname. The
    // forwarded/Host pair retains the public origin that the browser used.
    const host =
      request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
      request.headers.get("host")?.trim();
    const protocol =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      requestUrl.protocol.replace(":", "");
    if (host && (protocol === "http" || protocol === "https")) {
      trusted.add(`${protocol}://${host}`);
    }
    return trusted.has(candidate);
  } catch {
    return false;
  }
}
