import { NextResponse } from "next/server";

/** Prevent private booking and admin data from entering caches or referrers. */
export function proxy() {
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return response;
}

export const config = {
  matcher: ["/manage/:path*", "/admin/:path*", "/api/meet/:path*"],
};
