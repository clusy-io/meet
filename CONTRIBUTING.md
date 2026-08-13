# Contributing

Thanks for improving Meet.

1. Fork the repository and create a focused branch.
2. Copy `.env.example` to `.env.local`; mock mode requires no external accounts.
3. Run `npm install` and `npm run check`.
4. Open a pull request that explains the behavior change and its tests.

Keep pull requests small. Add regression coverage for booking lifecycle,
provider, timezone, token, or privacy changes. Do not include credentials,
production exports, real booking records, or screenshots containing personal
data. Report security issues privately as described in `SECURITY.md`.
