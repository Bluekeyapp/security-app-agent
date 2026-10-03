# SAB Agent

The mobile application used by security agents during patrols.

## What this repository contains

- Agent sign-in with badge and PIN.
- By default, the PIN stays in memory while the page is open. Agents sign in again after a refresh or browser restart; an unfinished patrol is retained locally for reauthentication.
- Agents may select « Rester connecté » on a personal device. This saves a random 30-day session token locally, never the PIN. PIN resets, agent deactivation, and the manager's global session reset also invalidate it.
- Route and checkpoint loading from Supabase.
- QR scanning, GPS capture, incidents, cancellations, comments, and tour history.
- Offline interface caching through the service worker.
- Patrols and incident photos are committed to IndexedDB before showing success. Failed local saves leave the current patrol unchanged and show a storage warning.
- Pending uploads retry after login, reconnecting, returning to the app, and every 30 seconds while signed in and online. Only the current agent's records are uploaded or displayed.
- Session expiry removes credentials while retaining patrols for reauthentication. Synchronized history is limited to 25 completed patrols per agent; unsent records and active patrols are retained.
- Agent-only client code and remote data calls.

The manager dashboard is maintained in the separate `security-app-manager` repository.

## Run locally

```powershell
npm ci
npm start
```

Open `http://localhost:8080/`. Camera and location features require localhost or HTTPS.

## Test

```powershell
npm test
npm run test:browser
```

The browser checks use Microsoft Edge on Windows. On other systems, run `npx playwright install chromium` first. Tests simulate server responses, storage failures, camera/GPS inputs, and offline recovery; they do not validate live Supabase authorization or physical-device behavior.

Existing localStorage patrols migrate to IndexedDB on startup. The old copy is removed only after every record has been saved, and existing IndexedDB records take precedence. Login still requires connectivity to validate credentials and load authorized routes. Pending work can resume after reauthentication, but browser-data deletion or uninstalling a home-screen app can remove local records.

## Deployment

This repository is a static site. Cloudflare Pages publishes the `main` branch at https://security-app-agent.pages.dev/. GitHub Actions runs tests on pushes and pull requests. No build command is required; publish `index.html`, `manifest.webmanifest`, `sw.js`, and the `assets/`, `src/`, and `styles/` directories together.

The Supabase URL and publishable key are configured in `src/config.js`. The browser only calls the protected agent RPC functions; PIN validation and tour validation remain server-side in Supabase.

Apply `security-app-manager/supabase/remembered-agent-sessions.sql` to Supabase before publishing this client version. A browser extension or script running on the same origin can access browser storage, so the option is intended for personal devices only.
