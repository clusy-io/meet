import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __resetMeetConfigCache } from "@/lib/meet/config";
import {
  decryptSecret,
  encryptSecret,
  randomToken,
  secretEquals,
  sign,
  verifySigned,
} from "@/lib/meet/crypto";

// crypto.ts reads MEET_TOKEN_SECRET through the cached config at call time,
// so the cache must be reset on both sides of the env mutation.
beforeAll(() => {
  process.env.MEET_MOCK_MODE = "1";
  process.env.MEET_TOKEN_SECRET = `test-secret-${"0".repeat(40)}`;
  __resetMeetConfigCache();
});

afterAll(() => {
  delete process.env.MEET_MOCK_MODE;
  delete process.env.MEET_TOKEN_SECRET;
  __resetMeetConfigCache();
});

/** Swap the first char of a base64url segment for a different valid char. */
function flipFirstChar(segment: string): string {
  return (segment[0] === "A" ? "B" : "A") + segment.slice(1);
}

describe("encryptSecret / decryptSecret", () => {
  it("roundtrips plaintext", () => {
    const ct = encryptSecret("refresh-token-value");
    expect(decryptSecret(ct)).toBe("refresh-token-value");
  });

  it("uses a fresh IV per encryption, and both ciphertexts decrypt", () => {
    const a = encryptSecret("same-plaintext");
    const b = encryptSecret("same-plaintext");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-plaintext");
    expect(decryptSecret(b)).toBe("same-plaintext");
  });

  it("throws on tampered ciphertext", () => {
    const parts = encryptSecret("sensitive").split(".");
    const tampered = [parts[0], parts[1], parts[2], flipFirstChar(parts[3])].join(".");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws on an unrecognized format", () => {
    expect(() => decryptSecret("not-a-ciphertext")).toThrow();
  });
});

describe("sign / verifySigned", () => {
  it("roundtrips a payload", () => {
    const signed = sign("hello-payload");
    expect(verifySigned(signed)).toBe("hello-payload");
  });

  it("rejects a bad signature", () => {
    const signed = sign("hello-payload");
    const idx = signed.lastIndexOf(".");
    const forged = signed.slice(0, idx + 1) + flipFirstChar(signed.slice(idx + 1));
    expect(verifySigned(forged)).toBeNull();
  });

  it("rejects a truncated value", () => {
    const signed = sign("hello-payload");
    expect(verifySigned(signed.slice(0, signed.length - 1))).toBeNull();
    expect(verifySigned("no-dot-at-all")).toBeNull();
  });
});

describe("secretEquals", () => {
  it("matches equal strings", () => {
    expect(secretEquals("swordfish", "swordfish")).toBe(true);
  });

  it("rejects different and different-length strings", () => {
    expect(secretEquals("swordfish", "sw0rdfish")).toBe(false);
    expect(secretEquals("swordfish", "swordfish2")).toBe(false);
  });
});

describe("randomToken", () => {
  it("is url-safe", () => {
    for (let i = 0; i < 10; i++) {
      expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("is unique across calls", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => randomToken()));
    expect(tokens.size).toBe(50);
  });
});
