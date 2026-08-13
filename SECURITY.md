# Security policy

## Supported versions

Security fixes are applied to the latest release on `main`. Older commits and
forks are not supported; operators should update and redeploy promptly.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Email
[security@clusy.io](mailto:security@clusy.io) with:

- the affected route or component;
- a concise reproduction;
- the impact you believe is possible; and
- any suggested mitigation.

We will acknowledge a complete report within five business days and coordinate
disclosure after a fix is available.

## Deployment responsibilities

Meet handles contact details, calendar data, encrypted OAuth refresh tokens,
and bearer management links. Operators are responsible for configuring access,
retention, consent, subprocessors, backups, and deletion workflows for their
jurisdiction. Never expose `SUPABASE_SERVICE_ROLE_KEY`, `MEET_TOKEN_SECRET`,
OAuth client secrets, `MEET_ADMIN_SECRET`, or `CRON_SECRET` to the browser.

Use separate credentials and databases for preview deployments. Do not connect
a public pull-request preview to production calendars or production Supabase.
