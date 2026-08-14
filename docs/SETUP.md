# Production setup and operations

This guide configures a standalone Meet deployment at an origin such as
`https://meet.example.com`.

## 1. Database

Create a Supabase project and run [`schema.sql`](schema.sql) in its SQL editor.
The script creates `meet_accounts` and `meet_bookings`, enables RLS,
and adds newer guest/reminder columns with explicit additive migrations.

Keep `SUPABASE_SERVICE_ROLE_KEY` server-only. The schema intentionally grants
no browser policy; all access goes through authenticated server routes.

Re-running `docs/schema.sql` is the upgrade path for an existing installation.
It is additive and idempotent, and it repairs its own constraints: the
booking-overlap constraint is checked by definition rather than by name, so an
installation created before per-person pages is upgraded in place instead of
silently keeping the older, global version.

## 2. Google OAuth

Create a Web application in Google Cloud and configure:

- production redirect: `https://meet.example.com/api/meet/oauth/google/callback`
- local redirect: `http://localhost:3000/api/meet/oauth/google/callback`
- scopes: `openid`, `email`, `calendar.readonly`, `calendar.events`

Set `MEET_GOOGLE_CLIENT_ID` and `MEET_GOOGLE_CLIENT_SECRET`. If the consent
screen is in testing mode, add every operator as a test user. Request offline
access so Google returns a refresh token.

## 3. Microsoft OAuth

Create a Microsoft Entra ID application with a Web redirect URI:

- production redirect: `https://meet.example.com/api/meet/oauth/microsoft/callback`
- local redirect: `http://localhost:3000/api/meet/oauth/microsoft/callback`

Grant delegated `offline_access`, `openid`, `email`, `User.Read`, and
`Calendars.ReadWrite` permissions. Set `MEET_MICROSOFT_CLIENT_ID` and
`MEET_MICROSOFT_CLIENT_SECRET`.

## 4. Email

Verify a domain in Resend, then set `RESEND_API_KEY` and `MEET_EMAIL_FROM`.
Use a dedicated subdomain when practical so transactional booking mail is
isolated from your primary domain reputation.

## 5. Required production configuration

Start from `.env.example`, leave `MEET_MOCK_MODE` empty, and set:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Bare public origin, for example `https://meet.example.com` |
| `MEET_MEMBERS` | JSON array of `{ key, name, email }` team members |
| `MEET_QUORUM` | Minimum number of free members required for a slot |
| `MEET_HOST_TIMEZONE` | IANA zone that defines working hours |
| `MEET_WINDOW_START`, `MEET_WINDOW_END` | Local booking window in `HH:MM` |
| `MEET_DURATION_MINUTES` | Event duration |
| `MEET_SLOT_STEP_MINUTES` | Grid step; must be at least the duration |
| `MEET_MIN_NOTICE_MINUTES` | Minimum advance notice |
| `MEET_HORIZON_DAYS` | Search horizon, maximum 366 |
| `MEET_EVENT_TITLE` | Event title; `{name}` expands to the booker |
| `MEET_EVENT_DESCRIPTION` | Description shared with attendees |
| `MEET_BRAND_NAME` | Name used in lifecycle email |
| `MEET_EMAIL_FROM` | Verified Resend sender |
| `MEET_ADMIN_SECRET` | Secret used to enter `/admin` |
| `MEET_TOKEN_SECRET` | Encryption and signing secret |
| `CRON_SECRET` | Bearer secret for the reminder worker |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only database credential |
| `MEET_SLACK_WEBHOOK_URL` | Optional. Slack Incoming Webhook for booking notices |
| `MEET_SLACK_ENABLED_AT` | Optional. Canonical ISO-Z instant; the on switch, and the cutoff before which nothing is announced |

Generate secrets independently:

```bash
openssl rand -hex 24 # MEET_ADMIN_SECRET
openssl rand -hex 32 # MEET_TOKEN_SECRET
openssl rand -hex 24 # CRON_SECRET
```

Changing `MEET_TOKEN_SECRET` makes stored OAuth refresh tokens and signed admin
sessions unreadable. Treat rotation as a migration: reconnect accounts after a
planned change.

## 6. Deploy and connect calendars

Deploy to a Node.js-compatible host. `vercel.json` schedules reminders every
15 minutes; on another host, invoke `/api/meet/cron/reminders` on that cadence
with `Authorization: Bearer $CRON_SECRET`.

Open `/admin`, sign in, connect each account, and select every calendar that
should count as busy. A selected calendar affects availability; the provider's
primary calendar is used for event creation.

Then open **Personal pages**. Every member of `MEET_MEMBERS` has a page at their
key (`/ada`), live by default and running on the team-wide settings. Anything
you leave blank there keeps inheriting, so you only need to fill in what differs
for that person: their hours, meeting length, notice, heading, event title, or
their own Slack webhook. Switching a page off makes it 404 for visitors while
keeping it visible here.

A page whose owner has no readable calendar can only ever show an empty month,
so the section warns about that rather than letting you publish a dead page.

### Slack (optional)

Create an Incoming Webhook at <https://api.slack.com/apps>, then set both
`MEET_SLACK_WEBHOOK_URL` and `MEET_SLACK_ENABLED_AT`. Both are required: the
webhook alone does nothing, which lets you store and check it before anything
can post.

`MEET_SLACK_ENABLED_AT` is a canonical ISO-Z instant (`2026-08-14T03:00:00Z`)
and doubles as a cutoff, so switching Slack on never announces bookings that
already existed. Cancellations are exempt, since a call still on the calendar
changing right now is worth hearing about.

Nothing is sent unless `NODE_ENV=production`, so previews and local development
stay silent even if a webhook is copied into them. If you set the variables in
your host's dashboard after a build, redeploy: environment added afterwards is
not in that build.

Do not provide production secrets to untrusted preview code. Give previews an
isolated database and OAuth clients, or run them only in mock mode.

## 7. Release verification

Before sharing the URL:

1. Confirm `/api/meet/availability` returns plausible slots in two timezones.
2. Book a call with a guest and verify event, video URL, team email, guest
   delivery, and ICS attachment.
3. Use the private manage URL to reschedule and cancel.
4. Verify `/admin`, OAuth callbacks, and manage/API responses are `no-store`,
   `no-referrer`, and `noindex`.
5. Call the reminder route with an invalid and valid secret.
6. Confirm logs and analytics do not capture any bearer token in
   `/manage/[token]`, `/api/meet/bookings/[token]/*`, or the
   `/api/meet/availability?token=...` query string.
7. Document retention and test deletion of expired booking data.

## Mock mode

Set `MEET_MOCK_MODE=1` for in-memory data, deterministic fake calendars,
console email, and an open local admin console. Mock data disappears whenever
the process restarts and must never be mistaken for durable production data.
