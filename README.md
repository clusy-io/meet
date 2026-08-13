# meet

A polished, self-hosted team scheduler for Google and Microsoft calendars.
Meet finds times when enough teammates are free, creates a video meeting,
sends lifecycle email, and gives each booker a private link to reschedule or
cancel—without sending visitors to a scheduling vendor.

Built and operated by [Clusy](https://clusy.io). The production booking flow
is available at [clusy.io/meet](https://clusy.io/meet).

## What you get

- **Team availability** across any mix of Google Calendar and Microsoft
  Outlook accounts, with configurable quorum and selected busy calendars.
- **A complete booking lifecycle**: confirmations, ICS attachments, guest
  invites, self-service rescheduling and cancellation, plus 24-hour and
  1-hour reminders.
- **Provider resilience**: organizer fallback, refresh-token rotation,
  request timeouts, degraded sync states, and truthful no-video fallback copy.
- **Timezone-safe scheduling** using IANA zones and DST-aware slot arithmetic.
- **A private admin console** for connecting accounts, selecting calendars,
  and reviewing bookings.
- **Accessible, responsive UI** with keyboard focus management, reduced-motion
  support, dark mode, and stable loading geometry.
- **A zero-credential mock mode** backed by in-memory calendars and console
  email, ideal for evaluation and UI work.

## Five-minute local start

Requirements: Node.js 22.13 or newer.

```bash
git clone https://github.com/clusy-io/meet.git
cd meet
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The example environment
enables `MEET_MOCK_MODE=1`, so no database, OAuth client, or email account is
needed. The mock admin console is at
[http://localhost:3000/admin](http://localhost:3000/admin).

## Architecture

```text
visitor -> availability API -> Google / Microsoft free-busy
        -> booking API      -> Supabase booking + provider event + Resend
        -> /manage/[token]  -> reschedule or cancel

operator -> /admin -> OAuth account connection + calendar selection
cron     -> /api/meet/cron/reminders -> 24-hour / 1-hour email
```

The app uses Next.js App Router. Supabase is accessed only with a server-side
service-role key; browser clients never connect to the database directly.
OAuth refresh tokens are encrypted before storage. Management URLs are bearer
capabilities and receive `no-store`, `no-referrer`, and `noindex` headers.

## Production setup

1. Create a Supabase project and run [`docs/schema.sql`](docs/schema.sql) in
   the SQL editor.
2. Register Google and/or Microsoft OAuth applications using the callback URLs
   in [`docs/SETUP.md`](docs/SETUP.md).
3. Verify a sending domain in Resend.
4. Configure the production environment from `.env.example`, set
   `MEET_MOCK_MODE` to empty, and use independent random values for every
   secret.
5. Deploy, open `/admin`, connect each team member's accounts, and select the
   calendars that count as busy.
6. Make one real booking, reschedule it, cancel it, and verify provider events,
   email delivery, private response headers, and the reminder cron.

Never put production service-role, OAuth, or calendar credentials in preview
deployments. Use an isolated preview Supabase project and OAuth applications,
or leave Meet in mock mode there.

See the complete [setup and operations guide](docs/SETUP.md) for every variable,
OAuth scope, callback, and deployment check.

## Configuration

The public Clusy branding is in [`src/meet.config.ts`](src/meet.config.ts).
Forks should edit it and replace the logo files under `public/`. Scheduling and
secret configuration is environment-driven:

| Group | Variables |
| --- | --- |
| Identity | `NEXT_PUBLIC_SITE_URL`, `MEET_BRAND_NAME`, `MEET_EMAIL_FROM` |
| Team | `MEET_MEMBERS`, `MEET_QUORUM`, `MEET_HOST_TIMEZONE` |
| Window | `MEET_WINDOW_START`, `MEET_WINDOW_END`, `MEET_DURATION_MINUTES`, `MEET_SLOT_STEP_MINUTES`, `MEET_MIN_NOTICE_MINUTES`, `MEET_HORIZON_DAYS` |
| Security | `MEET_ADMIN_SECRET`, `MEET_TOKEN_SECRET`, `CRON_SECRET` |
| Storage | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Providers | `MEET_GOOGLE_*`, `MEET_MICROSOFT_*`, `RESEND_API_KEY` |

`NEXT_PUBLIC_SITE_URL`, `MEET_MEMBERS`, and `MEET_EMAIL_FROM` are required
outside mock mode. Invalid windows, timezones, senders, member lists, quorum,
or durations fail configuration instead of silently using unsafe defaults.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Public booking page |
| `/manage/[token]` | Private bearer-link booking management |
| `/admin` | Secret-gated operator console |
| `/api/meet/availability` | Public availability |
| `/api/meet/bookings` | Booking lifecycle APIs |
| `/api/meet/oauth/*` | Google and Microsoft connection flow |
| `/api/meet/cron/reminders` | Secret-gated reminder worker |

## Tests

```bash
npm run lint
npm run typecheck
npm test
npm run build
# or all four
npm run check
```

The test suite covers timezone math, intervals, slot generation, configuration,
encryption, storage concurrency, request origin checks, emails, reminders,
Microsoft provider behavior, provider fallback, and stale reschedule rejection.

## Operational limits

- The included rate limiter is in-memory and per process. Public, high-traffic
  deployments should add a distributed limiter and bot challenge at the edge.
- Reminders use send-then-mark delivery. That protects against silent loss but
  an overlapping cron or crash after send can produce a duplicate. Use a
  durable leased outbox if exactly-once behavior is required.
- Provider timeouts are ambiguous: a calendar provider can accept an event
  immediately before the local request aborts. Periodic reconciliation is
  recommended for critical deployments.
- The schema does not purge booking history automatically. Define a retention
  period appropriate to your privacy policy and add a scheduled cleanup.
- A Microsoft refresh single-flight is process-local. Multiple serverless
  instances still need database-level compare-and-swap for strict rotation.

## Security and privacy

Read [`SECURITY.md`](SECURITY.md) before production use. Bookings contain names,
email addresses, notes, guest addresses, timestamps, event references, and
encrypted provider tokens. Publish an accurate privacy notice, limit access,
choose a retention period, and review Supabase, Google, Microsoft, Resend, and
your hosting provider as subprocessors.

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Please report vulnerabilities
privately rather than through a public issue.

## License

[MIT](LICENSE) © Clusy Inc. The Clusy name and logos are not licensed for use
as the identity of modified deployments; see [`NOTICE.md`](NOTICE.md).
