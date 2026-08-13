import "server-only";
import { getMeetConfig } from "./config";
import { decryptSecret, encryptSecret } from "./crypto";
import { getMeetStore } from "./store";
import { setRefreshTokenRotationHandler } from "./providers/microsoft";

/**
 * clusy/meet - persistence for Microsoft refresh-token rotation.
 *
 * Microsoft rotates refresh tokens on use. The in-memory alias map in
 * providers/microsoft.ts keeps this instance working, but the replacement
 * must also reach the store or the connection dies with the old token
 * (~90 days at the latest). This module lives apart from the provider so
 * the provider never imports the store (that would be circular);
 * providers/index.ts wires the registration.
 */

let registered = false;

/** Idempotent: safe to call on every provider lookup. */
export function registerMicrosoftTokenRotationPersistence(): void {
  if (registered) return;
  registered = true;
  setRefreshTokenRotationHandler(async (oldRefreshToken, newRefreshToken) => {
    if (getMeetConfig().mockMode) return;
    const store = getMeetStore();
    const accounts = await store.listAccounts();
    for (const account of accounts) {
      if (account.provider !== "microsoft") continue;
      let current: string;
      try {
        current = decryptSecret(account.refreshTokenEnc);
      } catch {
        // Undecryptable row (key rotation, corruption): cannot match it.
        continue;
      }
      if (current !== oldRefreshToken) continue;
      // This await is part of the provider request's critical path. Propagate
      // storage failures so a successful Graph call can never outlive its only
      // durable replacement credential.
      await store.updateAccount(account.id, {
        refreshTokenEnc: encryptSecret(newRefreshToken),
      });
    }
  });
}
