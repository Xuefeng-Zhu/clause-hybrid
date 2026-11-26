# Clause Development Guide

## Local development

Use Node.js `>=22.22.0` and pnpm `10.29.1`. If Corepack is installed, `corepack pnpm` selects the pinned version. [Package manifest](package.json)

```bash
pnpm install --frozen-lockfile
pnpm dev
```

The root pnpm workspace installs the web app. The [Expo app](apps/mobile/README.md) uses its own npm lockfile in `apps/mobile`.

Open the URL printed by `pnpm dev` (usually `http://localhost:8080`). Choose **Continue as local dev** when prompted. Clause uses PGlite at `data/pglite` by default. Both sample workflows are available without provider keys. Follow the contractor and travel-policy walkthroughs in the [README](README.md).

Run the repository checks from the project root.

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm agent-native:doctor
```

`pnpm typecheck` checks the generated app types and TypeScript. The test suite exercises contractor, policy, and Metal behavior with local fixtures and mocks. `pnpm agent-native:doctor` checks the framework's guards. A local build can report missing production database or auth settings while producing artifacts.

## Workspace and chat routes

Clause uses React Router v8 with file-based routes, React 19, and the Agent-Native Nitro backend. SSR renders the shell. The workspace loads job data through client action hooks.

| Route | Source and behavior |
| --- | --- |
| `/` | Sends the authenticated user to `/home`. [Sign-in landing](app/routes/_index.tsx) |
| `/home` | Renders the workspace for contractor and travel-policy jobs. The selected job is reflected in `?job=<jobId>`. [Contract Jobs](app/routes/home.tsx) |
| `/chat` | Opens a thread at `/chat/<threadId>`. [Chat entry](app/routes/chat._index.tsx) |
| `/chat/<threadId>` | Mounts `ChatRouteContent`. [Full-screen chat](app/routes/chat.$threadId.tsx) |

`app/components/layout/Layout.tsx` owns the app shell and contextual panel. On `/home`, `AgentInspector` wraps Toolkit's `AgentSidebar`. Full-screen chat uses `CoreAgentKitRoot`, `AgentKitChat`, and `CoreComposerRuntimeProvider` in `app/components/chat/ChatRouteContent.tsx`. Its transport comes from `@agent-native/core/client/agentkit-chat/transport`.

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

Define an operation in `actions/<verb>-<resource>.ts` with `defineAction` from `@agent-native/core/action`. Set `http: { method: "GET" }` for read actions. React callers use `useActionQuery` for reads and `useActionMutation` for writes. The framework mounts HTTP-enabled actions at `/_agent-native/actions/<name>`. Use `pnpm action --help` for CLI usage. The agent guide lists Clause's action arguments and owner approval rules. [AGENTS.md](AGENTS.md)

Reserve `server/routes/api/` for protocol endpoints such as streaming, OAuth callbacks, webhooks, or multipart transfers. Keep shared logic in actions or service modules. Register startup behavior in `server/plugins/` through a Nitro plugin.

The `cl_jobs` table stores jobs, including travel-policy jobs. `SqlJobStore` scopes reads and writes to the authenticated `owner_email`. Define SQL data with Drizzle's `pg-core` and use additive, PostgreSQL-compatible migrations in `server/plugins/db.ts`. The PGlite database exercises the same app schema locally.

Use the version-matched framework docs and public package entry points for framework APIs. After installing dependencies, the local action runner can read the optional Extensions capability docs as well as the actions and auth guides.

```bash
pnpm action docs-search --slug actions-defining
pnpm action docs-search --slug authentication
pnpm action docs-search --slug extensions
```

## Provider modes

The mock Airwallex gateway, mock Metal rail, and offline parsing fixtures are the defaults on a clean setup. Airwallex and Metal modes are selected independently. The workspace's sandbox tools show the Airwallex mode, and the contractor mandate panel shows the Metal mode.

### Airwallex sandbox

Set `AWX_CLIENT_ID` and `AWX_API_KEY` in **Settings → API keys** to use the sandbox API. `AWX_CARDHOLDER_ID` can point to an existing sandbox `DELEGATE` cardholder. The server also accepts the Airwallex credentials as an environment fallback for local or deployment configuration. Use the registered secret store for user credentials. The provider adapter targets `api.sandbox.airwallex.com` and the demo uses simulated transactions.

- Policy cards require both `PER_TRANSACTION` and `ALL_TIME` limits. Clause reads back the issuer controls after a write and displays verification on the card detail. If readback fails or the controls differ, Clause attempts to close a newly issued card or freeze an existing card and reports the outcome.
- The two-hour exception raises the card-wide `PER_TRANSACTION` cap. Clause restores the base cap during a simulated charge, before the first simulated swipe after expiry or after the next approved simulated swipe. This happens through the app's simulation flow.
- The sandbox uses its own clock. A future after-deadline simulation can temporarily change the sandbox card's active window and then attempt to restore it. Check the resulting card controls if this step fails.
- Clause saves the Metal payout outcome before attempting a best-effort simulated deposit into an Airwallex sandbox global account.

For optional provider smoke testing, supply the sandbox credentials through the command environment and run `pnpm smoke:sandbox`. It issues a sandbox card, runs the contractor sequence, and closes the card at the end of a successful run. Routine checks and the README walkthroughs use the mocks on a clean setup.

### Metal testnet

Set `METAL_MODE=testnet`, `METAL_RPC_URL`, and `METAL_ACCOUNT` together to select the testnet rail. The runtime uses the mock if any of these settings are missing. The server must have access to the following testnet resources.

| Setting | Required resource |
| --- | --- |
| `METAL_ACCOUNT` | Testnet principal address with the test assets needed for the demo payout |
| `METAL_RPC_URL` | Testnet RPC endpoint |
| `METAL_CONTRACTOR_ADDRESS` | Intended contractor testnet wallet. Set it explicitly to avoid the built-in demo payee. |
| `METAL_CLI_PREFIX` | Installation directory where `npx --prefix "$METAL_CLI_PREFIX" metal-agent` can run the CLI. Defaults to `/workspace/tools/metal`. |
| `METAL_DIR` | Writable directory outside the repository containing `owner-key.json` and `owner-key.issuer.public.json`. Clause writes per-job mandate files under `jobs/`. Defaults to `/workspace/work/metal`. |

Contract approval can bind a testnet mandate, and milestone approval can submit a testnet `*USDZ` payout. The Metal mock verifies its in-memory mandate even when the result says “Verified on chain.” In testnet mode the verifier invokes the CLI, and the reported refusal count can include locally recorded events.

### Models and credentials

`GEMINI_API_KEY` and `ANTHROPIC_API_KEY` are registered for the Clause document workflows. Gemini takes precedence when configured. Use the Agent-Native provider setup to enable chat. Bundled inputs can fall back to offline fixtures, and offline evidence review uses declared file kinds and a filename heuristic.

Clause resolves Airwallex and model keys for each authenticated request. A credential-store lookup failure returns `503 credential_store_unavailable` and can be retried. Contest mode skips lookup of direct model-provider keys.

### Approval and release recovery

Approval actions require a signed-in job owner and the framework's human approval gate. For a signed-in policy manager to issue a trip card or approve an exception, add their email to the deployment's `CLAUSE_POLICY_APPROVER_EMAILS` list. The job must belong to that account. The built-in demo identity can approve policy fixtures locally or in an auth-disabled preview using mock Airwallex.

Clause claims a milestone approval in the job record before changing the issuer controls. Matching a completed approval returns the saved job without dispatching a second payout. If a running attempt is interrupted or a provider call fails, inspect the recorded stage and payment ID via `get-job`. Verify the issuer controls and the Metal payment before taking any further action. The job holds the claim for manual reconciliation.

## Production database and authentication

For a standalone Node build, run `pnpm build` and then `pnpm start`. Configure the production environment with a persistent PostgreSQL `DATABASE_URL` and stable `BETTER_AUTH_SECRET` before deploying. The public auth URL is inferred by default, with `BETTER_AUTH_URL` available as an override. The Netlify build maps `NETLIFY_DATABASE_URL` to `DATABASE_URL` when supplied and runs `pnpm migrate:production` for production deployments. [Netlify configuration](netlify.toml)

The optional `AUTH_DISABLED=true` setting gives local or preview requests a shared identity. Use it only for isolated development or demo instances. Keep production secrets, provider keys, and Metal key material out of tracked files and logs. [Local environment example](.env.example)
