# Developing Clause

## Local development

Use Node.js `22.22.0` or later and pnpm `10.29.1`. With Corepack installed, `corepack pnpm` uses the version pinned in the package manifest. [Package manifest](package.json)

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open the URL printed by `pnpm dev`, usually `http://localhost:8080`. Choose **Continue as local dev** when prompted. The web app uses a local PGlite database in `data/pglite`. Both sample workflows run with the default mocks and require no provider keys. [Sample walkthroughs](README.md)

The root pnpm workspace installs the web app. The Expo app uses a separate npm lockfile in `apps/mobile`. [Mobile setup](apps/mobile/README.md)

## Checks

Run these commands from the repository root.

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm agent-native:doctor
```

Vitest uses local fixtures and mocks. Agent-Native Doctor checks the framework's repository guards. A local build can produce artifacts while reporting missing production database or auth settings. Use the Kane runbook for browser workflows. [Kane CLI runbook](docs/KANE.md)

## Web architecture

Clause uses React Router v8, React 19, and the Agent-Native Nitro backend. The server renders the shell. The workspace loads jobs through client action hooks.

| Route | Source and behavior |
| --- | --- |
| `/` | Opens the sign-in landing and sends authenticated users to `/home`. [Sign-in route](app/routes/_index.tsx) |
| `/home` | Shows contractor and travel-policy jobs. The selected job appears in `?job=<jobId>`. [Contract Jobs](app/routes/home.tsx) |
| `/chat` | Opens a thread at `/chat/<threadId>` when chat is enabled. [Chat entry](app/routes/chat._index.tsx) |
| `/chat/<threadId>` | Mounts `ChatRouteContent` when chat is enabled. [Full-screen chat](app/routes/chat.$threadId.tsx) |

`Layout.tsx` owns the app shell and contextual panel. On `/home`, `AgentInspector` wraps Toolkit's `AgentSidebar`. Full-screen chat uses `CoreAgentKitRoot`, `AgentKitChat`, and `CoreComposerRuntimeProvider` with the AgentKit chat transport. Contest mode hides the chat controls and redirects chat routes to `/home`. [Layout](app/components/layout/Layout.tsx) · [ChatRouteContent](app/components/chat/ChatRouteContent.tsx) · [Contest mode](docs/INFERENCE.md#contest-mode)

```text
app/components/clause/     Contract Jobs workspace, card controls, and demo UI
app/components/chat/      Thread entry and full-screen AgentKit chat
app/components/layout/    Shared navigation and AgentInspector
actions/                  Typed operations for the UI, HTTP, and agent
server/clause/            Terms, card rules, approvals, provider adapters, and job store
server/db/                Drizzle schema and database entry point
server/plugins/           Auth, agent prompt, registered secrets, and migrations
samples/                  Bundled contractor and travel-policy inputs
test/                     Contract, policy, UI, Metal, and model fallback tests
```

## Pages, actions, and data

Add pages in `app/routes/` and keep them under the existing app shell. Use `meta()` for page metadata and `HydrateFallback()` where a route needs a loading shell. Keep authenticated job data behind scoped actions.

Define operations in `actions/<verb>-<resource>.ts` with `defineAction` from `@agent-native/core/action`. Set `http: { method: "GET" }` for read actions. React callers use `useActionQuery` for reads and `useActionMutation` for writes. HTTP-enabled actions are available at `/_agent-native/actions/<name>`. Use `pnpm action --help` for CLI usage. [Action arguments and approval rules](AGENTS.md#actions)

Reserve `server/routes/api/` for protocol endpoints such as streaming, OAuth callbacks, webhooks, or multipart transfers. Keep shared logic in actions or service modules. Register startup behavior in `server/plugins/` through a Nitro plugin.

The `cl_jobs` table stores jobs, including travel-policy jobs. `SqlJobStore` scopes reads and writes to the authenticated `owner_email`. Define SQL data with Drizzle's `pg-core` and use additive, PostgreSQL-compatible migrations in `server/plugins/db.ts`. The PGlite database exercises the same app schema locally.

Use the local, version-matched framework docs and public package entry points for framework APIs.

```bash
pnpm action docs-search --slug actions-defining
pnpm action docs-search --slug authentication
pnpm action docs-search --slug extensions
```

## Provider modes

With a clean setup, Clause uses the Airwallex and Metal mocks and the bundled parsing fixtures. Configure the two gateways independently. The workspace sandbox shows the Airwallex mode, and the contractor mandate panel shows the Metal mode.

Jobs persist in SQL and the mocks keep cards and mandates in memory. Start a new sample job after restarting the app to get a usable mock card. **Reset demo** deletes the signed-in user's jobs and clears the mocks. Previously issued sandbox cards and testnet artifacts remain on their respective services.

### Airwallex sandbox

Set `AWX_CLIENT_ID` and `AWX_API_KEY` in **Settings → API keys** to use `api.sandbox.airwallex.com`. Set `AWX_CARDHOLDER_ID` to reuse an existing sandbox `DELEGATE` cardholder. Use the registered secret store for user credentials. The server also accepts deployment environment values for Airwallex.

- **Issuer verification.** Clause reads back the issuer controls after a write and shows the result in the card details. A trip card requires both `PER_TRANSACTION` and `ALL_TIME` limits. If verification fails, Clause attempts to close a newly issued card or freeze an existing card and reports the outcome.
- **Exception limits.** The two-hour exception raises the card-wide `PER_TRANSACTION` cap across allowed merchant categories. The simulator restores the base cap after the next approved charge, including one under the original cap, or before the first simulated charge after expiry.
- **Expiry simulation.** Airwallex uses its own clock. To simulate a future charge after the deadline, Clause can temporarily change the sandbox card's active window and then attempt to restore it. Check the issuer controls if that step fails.
- **Deposit simulation.** Clause saves the Metal payout outcome before attempting a simulated deposit into an Airwallex sandbox global account.

To smoke-test the provider, supply sandbox credentials through the command environment and run `pnpm smoke:sandbox`. This creates a sandbox card, runs the contractor sequence with simulated transactions, and closes the card at the end of a successful run.

### Metal testnet

Set `METAL_MODE=testnet`, `METAL_RPC_URL`, and `METAL_ACCOUNT` together to select the testnet rail. The runtime uses the mock if any are missing. Configure the testnet resources below on the server.

| Setting | Required resource |
| --- | --- |
| `METAL_ACCOUNT` | Testnet principal address with the test assets needed for the demo payout |
| `METAL_RPC_URL` | Testnet RPC endpoint |
| `METAL_CONTRACTOR_ADDRESS` | Intended contractor testnet wallet. Set it explicitly to avoid the built-in demo payee. |
| `METAL_CLI_PREFIX` | Installation directory where `npx --prefix "$METAL_CLI_PREFIX" metal-agent` can run the CLI. Defaults to `/workspace/tools/metal`. |
| `METAL_DIR` | Writable directory outside the repository containing `owner-key.json` and `owner-key.issuer.public.json`. Clause writes per-job mandate files under `jobs/`. Defaults to `/workspace/work/metal`. |

Contract approval can bind a testnet mandate, and milestone approval can submit a testnet `*USDZ` payout. Testnet verification invokes the Metal CLI, and its refusal count can include locally recorded events. The **Verified on chain** label in mock mode reflects in-memory verification.

### Models and credentials

Set `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` in **Settings → API keys** to configure a server model for Clause document workflows. Gemini takes precedence when configured. Configure a chat provider separately through the Agent-Native settings. Bundled documents can fall back to offline fixtures, and offline evidence review uses declared file kinds and a filename heuristic. [Hybrid inference and fallback behavior](docs/INFERENCE.md)

Clause resolves Airwallex and model keys for each authenticated request. A credential-store lookup failure returns `503 credential_store_unavailable` and can be retried. Contest mode skips lookup of direct model-provider keys.

## Approval and release recovery

Approval actions require a signed-in job owner and the framework's human approval gate. For a signed-in policy manager to issue a trip card or approve an exception, add their email to the deployment's `CLAUSE_POLICY_APPROVER_EMAILS` list. The job must belong to that account. The built-in demo identity can approve policy fixtures locally or in an auth-disabled preview using mock Airwallex.

Clause records a milestone approval claim before changing issuer controls. A matching retry after completion returns the saved job and preserves the existing payout. If an attempt is interrupted or a provider call fails, `get-job` reports the stage and payment ID. Verify the issuer controls and the Metal payment using that ID. Clause holds the claim for manual reconciliation.

## Production database and authentication

For a standalone Node deployment, configure a persistent PostgreSQL `DATABASE_URL` and stable `BETTER_AUTH_SECRET`, then run `pnpm build` and `pnpm start`. Clause infers the public auth URL by default. Set `BETTER_AUTH_URL` to override it.

The Netlify build maps `NETLIFY_DATABASE_URL` to `DATABASE_URL` when supplied and runs `pnpm migrate:production` for production deployments. [Netlify configuration](netlify.toml)

Use `AUTH_DISABLED=true` only for isolated development or disposable previews. It gives all requests a shared identity. Store deployment and provider secrets outside tracked files. [Environment example](.env.example) · [InstaBox demo runbook](deploy/README-instabox-preview.md)
