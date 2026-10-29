# Office Hours — lecturer appointment booking

A full-stack appointment scheduler for a single lecturer. Students can see open office-hour times and book a session; the lecturer dashboard manages availability and bookings. The API stores appointments in SQLite.

## Requirements

- Node.js 20.19+ or 22.12+
- npm

## Run locally

1. Install root and API dependencies with `npm install` and `npm install --prefix server`.
2. Start both the API and Vite frontend with `npm run dev` from the project root.
3. Open the Vite URL printed in the terminal (typically `http://localhost:5173`). The API listens on port `3001`.

The frontend can also be run from `frontend` using `npm run dev`; in that case, start the API separately with `npm run dev --prefix server`.

## Features

- Email OTP verification before appointment booking or waitlisting.
- Lecturer sign-in for dashboard access.
- Rolling 60-day availability calendar; students may book at most once per date.
- Lecturer dashboard for appointments, waitlist, slot management, and come/not-come email notices.
- First-party aggregate booking funnel analytics, privacy policy, and terms pages.
- SQLite persistence and server-side validation of dates, time blocks, overlaps, and booking data.

## API endpoints

- `GET /api/health`, `GET /api/slots`, `GET /api/stats`
- `GET /api/slots/manage` (lecturer only), `POST /api/slots`, `DELETE /api/slots/:id`
- `POST /api/email/otp/request`, `POST /api/email/otp/verify`
- `POST /api/login`, `POST /api/logout`, `GET /api/session`
- `GET /api/lecturer/status`, `POST /api/lecturer/password/request-code`, `POST /api/lecturer/password/set`
- `POST /api/bookings`, `DELETE /api/bookings/:id`
- `POST /api/attendance-notices` (lecturer only)

## Production readiness and deployment

The API requires lecturer credentials, SMTP settings, an allowed frontend origin, and a durable database path when `NODE_ENV=production`. Lecturer email and password are configured in server environment variables. Lecturer sessions and student OTP hashes are stored in SQLite; public API requests, sign-in, OTP, booking, waitlist, and email-sending routes are rate-limited. All lecturer data and mutation routes enforce server-side authentication. The frontend does not contain lecturer credentials, and dashboard tokens are kept in tab-scoped session storage.

### Render deployment

The included `render.yaml` configures one API instance and a persistent disk mounted at `/var/data`. Persistent disks require a Render plan that supports disks and SQLite should stay on a single API instance. Configure the Blueprint secrets/settings when prompted:

- `FRONTEND_ORIGIN` (the exact HTTPS origin of the deployed static site, without a path)
- `LECTURER_EMAIL` (the lecturer creates her own password on first visit to the sign-in page; a code is emailed to this address, and the same flow handles forgotten passwords)
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`
- `VITE_API_URL` on the static site (the HTTPS API URL ending in `/api`)

**Credential incident:** a populated `server/.env` containing an SMTP app password and lecturer credentials was present in the supplied workspace. The `.env` file, a stray copy of SMTP settings in `frontend/src`, and the local database files have been removed from this package, and `.env` files are ignored, but the credential values must be rotated immediately at their providers (revoke the exposed Gmail app password, issue a replacement, and change the lecturer password everywhere it was reused). Treat those values as compromised; removing a local file does not erase prior Git history, machine backups, or copies. Check any remotes/history independently and rewrite history only if the file was ever pushed, coordinating with collaborators. No Git metadata was available in this workspace to verify whether any key was ever committed. No payment provider/API key was present in the scanned project files.

Before accepting real records, configure off-host, encrypted, access-controlled backups and test restoration using `npm run backup --prefix server` and `npm run restore:check --prefix server -- <backup-file>`. The restore check opens a separate temporary restored copy; it does not overwrite the live database. For reliable email deliverability, use a verified sending domain/provider with SPF, DKIM, and DMARC configured and monitor delivery/bounces. The app currently has a single lecturer login and no student signup, payment, or password-reset flow, so those end-to-end tests/workflows are not applicable or implemented. Local first-party analytics records only allowlisted aggregate funnel counts; it is not a third-party analytics integration.

#### Launch rollback checklist

1. Set the static site to maintenance mode or roll it back to the previously deployed build; stop promoting new API builds.
2. Preserve logs and take a fresh SQLite online backup before any recovery action. Never restore over a live database without stopping writes and making another copy.
3. If the database is suspect, run `npm run restore:check --prefix server -- <backup-file>` and restore a verified copy during a maintenance window. Confirm appointment, waitlist, and session tables before reopening writes.
4. Revert API and frontend to the last known-good deployment together, checking their configured API origin and migration compatibility. Take an outage window if the prior API cannot safely operate with the current schema.
5. Rotate any potentially exposed lecturer or SMTP credentials, update the deployment secrets, and verify login, OTP email, booking and lecturer access before reopening traffic.
6. Re-enable traffic, verify health, booking, and notification flows, then communicate any appointment changes to affected students.

The rollback steps need an operator with access to the hosting provider, secret manager, and off-host backup. A local backup is not a substitute for an independently stored production copy.

### Local development

Copy `server/.env.example` to `server/.env`, configure lecturer credentials and SMTP settings, and run `npm run dev` from the root. Sign in to the lecturer dashboard with the email and password configured in `server/.env`. Do not reuse development credentials in a deployed environment.

