import { describe, expect, it } from "vitest";
import { hasTrustedMutationOrigin } from "../requestSecurity";

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://meet.example.com/api/meet/bookings", { method: "POST", headers });
}

describe("Meet mutation origin checks", () => {
  it("allows same-origin browsers and originless authenticated scripts", () => {
    expect(hasTrustedMutationOrigin(request({ origin: "https://meet.example.com" }))).toBe(true);
    expect(hasTrustedMutationOrigin(request())).toBe(true);
  });

  it("uses the forwarded public origin when a deployment normalizes request.url", () => {
    expect(
      hasTrustedMutationOrigin(
        new Request("http://internal-next:3000/api/meet/bookings", {
          method: "POST",
          headers: {
            origin: "https://meet.example.com",
            "x-forwarded-host": "meet.example.com",
            "x-forwarded-proto": "https",
          },
        })
      )
    ).toBe(true);
  });

  it("rejects cross-site and malformed browser origins", () => {
    expect(hasTrustedMutationOrigin(request({ origin: "https://attacker.example" }))).toBe(false);
    expect(
      hasTrustedMutationOrigin(
        request({ origin: "https://meet.example.com", "sec-fetch-site": "cross-site" })
      )
    ).toBe(false);
    expect(hasTrustedMutationOrigin(request({ origin: "not a URL" }))).toBe(false);
  });
});
