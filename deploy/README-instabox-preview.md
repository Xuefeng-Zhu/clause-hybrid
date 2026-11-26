# Deploy the Clause demo on InstaBox

The public demo runs on the `clause-hybrid-demo` Linux machine. The 8 GiB free sandbox pauses after 30 minutes of inactivity. If the demo stops responding, check the machine state and resume it from the dashboard. [Live demo](https://8080-agrbns4donht7p3tyd2gpj43qe.instabox.tech/home) · [InstaBox machines](https://dashboard.instabox.sh/dashboard/machines)

All visitors share one demo workspace. The preview runs in contest mode with temporary PGlite storage and the Airwallex and Metal mocks. Use the bundled sample documents on the public instance. [Contest mode](../docs/INFERENCE.md#contest-mode)

## Prepare the machine

1. Keep a Git checkout of `Xuefeng-Zhu/clause-hybrid` at `/data/clause-hybrid`. Install Docker, Git, Node.js 22 or later, OpenSSL, and `flock` on the machine.
2. Put the Firebase web settings in `.env.local`, one `KEY=value` per line. The script requires `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, and `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY`. It passes only supported web settings to Docker. [Environment example](../.env.example)
3. Publish port `8080` in the machine's **Ports** tab. Add the resulting public hostname to the allowed domains for the reCAPTCHA Enterprise key.

## Deploy a commit

Run the deployment on the InstaBox machine. You can pass a specific commit SHA in place of `origin/main`.

```bash
cd /data/clause-hybrid
git fetch origin
git merge --ff-only origin/main
bash deploy/deploy-instabox-preview.sh deploy origin/main
```

The script builds from the selected Git commit while the existing container serves traffic. It then starts a replacement with fresh demo data and runs local health checks. If the replacement fails, the script restores the previous container and its running state. The first deploy generates `BETTER_AUTH_SECRET` in `/data/clause-preview/runtime.env`, and later deploys reuse that file.

## Verify the deployment

Check the running image's revision on the machine.

```bash
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' clause-hybrid-demo
```

Run the read-only HTTPS smoke check from any checkout with Node.js. It checks health, the workspace, and mock runtime status.

```bash
bash deploy/deploy-instabox-preview.sh smoke https://8080-agrbns4donht7p3tyd2gpj43qe.instabox.tech
```

To verify browser inference, open `/home`, select **Use sample quote**, then **Read quote**. Check the inference source badge on the resulting draft.

Run Kane travel flow `06` against a disposable hosted instance with both gateways in mock mode. The flow creates a sample trip job and simulates transactions. [Kane CLI runbook](../docs/KANE.md)

For Firebase Hosting and Cloud Run, use the separate preview runbook. [Cloud Run preview](./README-preview.md)
