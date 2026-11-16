# Kane preview deploy (expiring)

Throwaway hosted preview for automated testing. Not production.

- Cloud Run service `clause-hybrid-preview` (us-west1), min 0 / max 2 instances, 1 vCPU / 2 GiB, unauthenticated.
- Firebase Hosting preview channel `kane` (7-day expiry) rewrites `**` to the Cloud Run service. The live channel is not used.
- DB: built-in PGlite on the container's in-memory filesystem (no `DATABASE_URL`). Data resets when an instance stops, and two instances do not share data.
- Runtime env: `AUTH_DISABLED=true` (shared `dev@local.test` identity), `NETLIFY_LOCAL=true` (the framework's local-emulator marker; lets the production bundle use PGlite), random `BETTER_AUTH_SECRET` per deploy.
- Client `VITE_*` values come from `.env.local` as Cloud Build substitutions/build args. `VITE_APPCHECK_DEBUG_TOKEN` is never passed and is forced empty in the Dockerfile.

```bash
source /workspace/tools/agy-env.sh
export CLOUDSDK_AUTH_ACCESS_TOKEN=$(gcloud auth application-default print-access-token)
deploy/deploy-preview.sh build    # async Cloud Build; wait for SUCCESS
deploy/deploy-preview.sh run      # Cloud Run deploy
deploy/deploy-preview.sh channel  # Hosting preview channel "kane"
```

Note: Firebase Hosting only forwards the `__session` cookie to Cloud Run, so real sign-in would not work through the channel URL. That is fine with `AUTH_DISABLED=true`.

Tear down: `gcloud run services delete clause-hybrid-preview --region us-west1` and `firebase hosting:channel:delete kane`.
