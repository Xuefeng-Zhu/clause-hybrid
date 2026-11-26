# InstaBox demo preview

The [Clause demo](https://8080-agrbns4donht7p3tyd2gpj43qe.instabox.tech/home) runs on the `clause-hybrid-demo` Linux machine. The current free sandbox has 8 GiB RAM and auto-pauses after 30 idle minutes. An operator can resume it from the [InstaBox machines dashboard](https://dashboard.instabox.sh/dashboard/machines).

## Deploy a commit

On the InstaBox machine, keep a Git checkout of `Xuefeng-Zhu/clause-hybrid` at `/data/clause-hybrid`. The machine needs Docker, Git, Node.js 22 or newer, OpenSSL, and `flock`. Copy the Firebase web settings listed in `.env.example` into the checkout's `.env.local`. Register the public hostname in the reCAPTCHA Enterprise key's allowed domains. The build reads only the listed Firebase `VITE_*` settings, with one `KEY=value` per line. Keep `BETTER_AUTH_SECRET` and provider credentials out of the web settings file.

```bash
cd /data/clause-hybrid
git fetch origin
git merge --ff-only origin/main
bash deploy/deploy-instabox-preview.sh deploy origin/main
```

The script builds an image from the selected Git commit while the running container serves traffic. It starts the replacement on port 8080 and checks local health, the workspace, and the mock runtime. If the replacement fails, it restores the previous container and its running state. A successful replacement starts with fresh demo data. The script generates a private runtime secret in `/data/clause-preview/runtime.env` on the first deploy and reuses it for later deploys.

## Verify the HTTPS endpoint

Publish local port 8080 from the machine's **Ports** tab. Then run the smoke check from any checkout with Node.js:

```bash
bash deploy/deploy-instabox-preview.sh smoke https://8080-agrbns4donht7p3tyd2gpj43qe.instabox.tech
```

The smoke check makes read-only requests to the public health, workspace, and job-list endpoints. To verify browser inference, open `/home`, choose **Use sample quote**, select **Read quote**, and check the source badge on the draft. Run the [travel exception browser flow](../docs/KANE.md) on an isolated test instance with the mock gateways enabled.

This preview uses a shared demo identity, temporary PGlite storage, and the Airwallex and Metal mocks. Use the bundled samples on the public preview. `CLAUSE_CONTEST_MODE=true` routes generative AI through Firebase AI Logic in the browser. The existing [Cloud Run preview](./README-preview.md) has its own deployment steps.
