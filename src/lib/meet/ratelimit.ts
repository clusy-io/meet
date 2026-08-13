/**
 * clusy/meet: in-memory rate limiter.
 *
 * This is a local abuse brake, not a distributed quota. High-traffic public
 * deployments should replace it with a shared TTL-backed limiter and bot or
 * email-ownership verification. Stale keys are pruned opportunistically.
 */

const hits = new Map<string, number[]>();
let lastSweep = 0;
const MAX_WINDOW_MS = 15 * 60_000;

function sweep(now: number): void {
  if (now - lastSweep < MAX_WINDOW_MS) return;
  lastSweep = now;
  for (const [key, timestamps] of hits) {
    const fresh = timestamps.filter((time) => time > now - MAX_WINDOW_MS);
    if (fresh.length === 0) hits.delete(key);
    else hits.set(key, fresh);
  }
}

/** True when the caller is under `max` events per `windowMs`; records the hit. */
export function rateLimit(bucket: string, ip: string, max: number, windowMs: number): boolean {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  sweep(now);
  const fresh = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  if (fresh.length >= max) {
    hits.set(key, fresh);
    return false;
  }
  fresh.push(now);
  hits.set(key, fresh);
  return true;
}
