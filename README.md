# SAB Security Agent

The mobile application used by security agents during patrols.

## What this repository contains

- Agent sign-in with badge and PIN.
- Route and checkpoint loading from Supabase.
- QR scanning, GPS capture, incidents, cancellations, comments, and tour history.
- Offline interface caching through the service worker.
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
```

## Deployment

This repository is a static site. Configure the hosting provider to publish the repository root; no build command is required.

The Supabase URL and publishable key are configured in `src/config.js`. The browser only calls the protected agent RPC functions; PIN validation and tour validation remain server-side in Supabase.
