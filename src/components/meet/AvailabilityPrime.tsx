import type { ReactElement } from "react";

/**
 * Starts the availability request during HTML parsing, before hydration.
 *
 * SlotPicker asks for availability from an effect, so the request could not
 * begin until the bundle had downloaded, parsed and hydrated. That gap was
 * measured at 230-390ms on the booking pages, and it is pure dead time: the
 * request depends on nothing the client computes. An inline script issues the
 * identical request while the parser is still working, and SlotPicker adopts
 * the in-flight promise instead of starting its own.
 *
 * Same reasoning and placement as the theme-init script in layout.tsx: a plain
 * inline <script>, not next/script, because `beforeInteractive` only queues the
 * source for the Next runtime to run after the bootstrap chunks load, which is
 * after the moment this exists to get in front of.
 *
 * Deliberately NOT a server prefetch into initialData. That would move the
 * provider latency onto TTFB and leave the visitor looking at nothing, instead
 * of at a calendar that fills in.
 *
 * The URL must match byte for byte what SlotPicker builds, or the adoption
 * check fails and it simply falls back to fetching normally: the priming is an
 * optimisation, never a correctness dependency.
 */
export function AvailabilityPrime({ host }: { host?: string }): ReactElement {
  const url = host
    ? `/api/meet/availability?host=${encodeURIComponent(host)}`
    : "/api/meet/availability";

  // The catch is mandatory, not defensive: without a handler attached in the
  // same tick, a rejection here is an unhandled promise rejection, which is a
  // console error, which fails the invariant suite's console check. The real
  // handling happens when SlotPicker awaits this same promise.
  const source =
    `(function(){try{var u=${JSON.stringify(url)};` +
    `var p=fetch(u).then(function(r){return r.ok?r.json():Promise.reject(r.status)});` +
    `p.catch(function(){});window.__clusyMeetAvail={url:u,p:p};}catch(e){}})();`;

  return <script id="meet-availability-prime" dangerouslySetInnerHTML={{ __html: source }} />;
}
