import { SITE } from "@/meet.config";

export interface ProductCta {
  /** Small label above the sentence. */
  lead: string;
  /** One sentence. */
  body: string;
  linkLabel: string;
  href: string;
}

/**
 * An optional nudge shown once a booking is confirmed.
 *
 * Off unless `SITE.cta` is set, because a scheduler that advertises something
 * by default would be advertising someone else's product in every fork. Set it
 * in `src/meet.config.ts` to switch it on.
 *
 * It renders on two surfaces built in completely different ways: the
 * confirmation card (React) and the booker's confirmation email (hand-written
 * HTML plus a separately hand-written plaintext body). Those two email bodies
 * have drifted apart before, because each spelled its copy out by hand, and the
 * drift was invisible to anyone reading only the HTML. Both derive from this.
 *
 * Tone note: it sits directly under "You're booked", addressed to someone who
 * has just committed to a call. One quiet line and one link. If it ever grows a
 * second sentence or a coloured banner, it has become an ad.
 */
export function productCta(): ProductCta | null {
  const cta = (SITE as { cta?: Partial<ProductCta> }).cta;
  if (!cta) return null;
  const { lead, body, linkLabel, href } = cta;
  // All four or nothing: a half-configured CTA would render a link with no
  // explanation, or a sentence that cannot be acted on.
  if (!lead || !body || !linkLabel || !href) return null;
  return { lead, body, linkLabel, href };
}
