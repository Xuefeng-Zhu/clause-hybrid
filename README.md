# Clause

[Open the live demo](https://clause-7j1k.onrender.com/)

Clause turns a contractor quote or an approved business trip into an Airwallex virtual card with spending controls derived from the source document. Contract cards use a cumulative cap based on released milestones and pair with a Metal payout mandate. Trip cards use a trip budget, a per-charge cap, and manager-approved exceptions. Clause shows the source clauses behind each planned rule and cites the applicable clause when a decline maps to one.

## Quick start

Use Node.js 22.22.0 or later and pnpm 10.29.1, the version pinned in [package.json](./package.json). Corepack selects that version for the commands below.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Open the URL printed by the dev server, usually `http://localhost:8080`. On the welcome screen, choose **Continue as local dev** to reach the **Contract Jobs** workspace at `/home`.

Both walkthroughs use the default in-memory Airwallex and Metal mocks and the bundled parsing fixtures. They require zero external keys. **Sandbox → Environment & parser** shows the card gateway and parser in use. The optional Clause chat sidebar and full-screen chat at `/chat` require an Agent-Native model connection. Use the chat setup prompt or **Settings → Model**.

## Run the demos

Start each walkthrough with **New job**. The sample dates are fixed. Run the ordinary authorizations before the relevant sample card expires on November 23, 2026 for the trip or December 18, 2026 for the original contract. The explicitly dated late presets are designed to show expiry declines.

### Contractor quote · Maple Street Café

1. Choose **Use sample quote** and **Read quote** to load [the Maple Street Café quote](./samples/quote-maple-street-cafe.txt). Review its clauses and choose **Approve & issue card**. The signing milestone (M1) sets the initial cumulative card cap at **$4,000**, and approval creates a contractor payout mandate.
2. Open **Sandbox**. Run **Dunn Lumber ($1,840.50)**, **Kirkland Taphouse ($86.40)**, then **Home Depot ($2,500)** in that order. Lumber is approved. Lunch is declined under the meals ban (§2.2). Home Depot exceeds the remaining released funds (§1.1).
3. In **Metal payout mandate**, run **Pay contractor over the cap** and **Pay a different wallet**. The payout attempts are refused. Close the drawer.
4. Choose **Submit proof for Milestone 2**, keep **Photos** selected, and choose **Evaluate proof**. With the attachment field empty, Clause uses the [bundled cabinet photo](./public/samples/cabinets-installed.jpg). Review the verdict and choose the **Approve release** button for Milestone 2. The cap rises to **$9,000**. In mock mode this also records a **50 USDZ** simulated Metal payout and a **$5,000** simulated Airwallex deposit. Reopen **Sandbox** and retry **Home Depot** to see it approved. Close the drawer.
5. Choose **Propose change order**. Keep the prefilled [sample email](./samples/change-order-email.txt) and choose **Propose change order** again inside the sheet. Review the changes and choose the approval button. The released cap rises to **$9,800**, the deadline moves to December 23, 2026, and Clause replaces the mandate with higher limits while carrying forward recorded spend.
6. Reopen **Sandbox**, run **McLendon Hardware** dated December 24, and confirm the deadline decline cites the approved change order. Choose **Verify mandate on chain** to check the mandate. In mock mode the two refusals and one payment come from in-memory state.

### Travel and expense policy · Acme Robotics

1. Choose **Travel policy + trip request** and **Read policy & trip** to load [the Acme policy and trip TR-2611](./samples/policy-acme-trip.txt). Review the extracted terms and choose **Approve & issue trip card**. In mock mode the card has a **$2,000** trip budget and a **$300** per-charge cap.
2. Open **Sandbox** and run the presets for **Hyatt Regency Austin ($289)** and **Uber Trip ($34.60)**. Both pass. **Rainey St. Cocktail Bar ($142)** and **Best Buy #512 ($899)** are declined under §§4.2 and 4.1, respectively. The **Uber Trip** dated November 26 is declined under the expiry clause (§2.1).
3. Turn on **Employee phone view** in the Sandbox drawer. Run **Uchi Austin ($480)** and confirm the decline cites the single-charge cap (§3.3). Close the drawer. In the phone view, keep the sample note naming the client and four attendees, then choose **Request an exception (§3.4)**.
4. Choose **Approve exception** under **Live enforcement**. The sample per-attendee rule allows **$500** for four named attendees. Reopen **Sandbox** and retry **Uchi Austin**. The charge passes and the simulator restores the **$300** base cap. Run the same preset once more to see it declined again.
5. Close the drawer, open **Expense report — auto-generated**, and choose **Export CSV**. With the two approved in-policy charges and one approved dinner, the report shows **$803.60** in approved spend, the blocked attempts, and **$0.00** owed to the traveler.

**Reset demo** deletes every job belonging to the signed-in user, including custom jobs, and clears the app process's mock gateways. Previously issued Airwallex sandbox cards and Metal testnet mandates remain on their respective services.

## Provider configuration

For custom contractor quotes and trip policies, paste the document text into **New job**. Milestone proof accepts JPEG or PNG photos and PDFs. The workspace registers the following keys in **Settings → API keys**.

| Setting | Effect |
| --- | --- |
| `AWX_CLIENT_ID` and `AWX_API_KEY` | Enables Airwallex Issuing calls to `api.sandbox.airwallex.com`. All card transactions in the walkthrough are simulated. |
| `AWX_CARDHOLDER_ID` | Optionally reuses a pre-created `DELEGATE` cardholder in the Airwallex sandbox. |
| `GEMINI_API_KEY` | Enables Gemini for quote and policy extraction, proof review, change orders, and exception notes. |
| `ANTHROPIC_API_KEY` | Enables Claude for those tasks when Gemini is unconfigured. |

The workspace can fall back to bundled fixtures on model failure. Offline proof evaluation checks the declared evidence kinds and uses a filename heuristic. The current document workflow stores resolved model keys in process-wide configuration, so a request without a key can reuse a previous request's key.

Metal defaults to mock mode independently of Airwallex. See the [development guide](./DEVELOPING.md) for the testnet account, CLI, and deployment settings.

## Hybrid inference

Clause runs structured extraction and review in the browser via Firebase AI Logic hybrid inference (`app/lib/hybrid-ai.ts`): Chrome Gemini Nano on-device when available, and `gemini-3.5-flash-lite` in the cloud otherwise. Per-step inference modes can be tuned in Firebase Remote Config (`app/lib/firebase.ts`) while preserving the in-code defaults below. Every wrapper shows an `AiSourceBadge` in the UI, validates model output deterministically before applying state changes, and falls back to the existing server action path on failure or unavailability (offline rules only in contest mode; never in strict on-device mode).

| Step | Remote Config key | Default mode | Browser wrapper & deterministic boundary | Cloud model & server fallback |
| --- | --- | --- | --- | --- |
| `contract` | `contract_mode` (`parse_mode`) | `PREFER_ON_DEVICE` (`prefer_on_device`; `prefer_in_cloud` above `parse_cloud_char_threshold`) | [`app/lib/clause-ai/parse.ts`](./app/lib/clause-ai/parse.ts) — renumbers duplicate milestone IDs, flags non-verbatim quotes, runs `validateTerms` | `gemini-3.5-flash-lite`; [`server/clause/contract/parser.ts`](./server/clause/contract/parser.ts) |
| `expense` | `expense_mode` | `PREFER_ON_DEVICE` (`prefer_on_device`; `prefer_in_cloud` above `parse_cloud_char_threshold`) | [`app/lib/clause-ai/expense.ts`](./app/lib/clause-ai/expense.ts) — `validateExpenseTerms` checks calendar dates, 48h `card_expires`, and `per_charge_cap <= budget` | `gemini-3.5-flash-lite`; [`server/clause/expense/parser.ts`](./server/clause/expense/parser.ts) |
| `exception` | `exception_mode` | `PREFER_ON_DEVICE` (`prefer_on_device`) | [`app/lib/clause-ai/exception.ts`](./app/lib/clause-ai/exception.ts) — AI explains only; `validateExceptionExtraction` computes `125 * attendees` cap | `gemini-3.5-flash-lite`; [`server/clause/expense/exception.ts`](./server/clause/expense/exception.ts) |
| `changeOrder` | `changeOrder_mode` | `PREFER_IN_CLOUD` (`prefer_in_cloud`) | [`app/lib/clause-ai/changeOrder.ts`](./app/lib/clause-ai/changeOrder.ts) — AI drafts deltas/dates/quote only; `validateChangeOrderDraft` computes milestone `new_amount` & contract total | `gemini-3.5-flash-lite`; [`server/clause/contract/changeOrder.ts`](./server/clause/contract/changeOrder.ts) |
| `evidence` | `evidence_mode` | `PREFER_IN_CLOUD` (`prefer_in_cloud`) | [`app/lib/clause-ai/evidence.ts`](./app/lib/clause-ai/evidence.ts) — downscales image input to one max-`768px` JPEG single-turn; code checks missing kinds & hashes originals | `gemini-3.5-flash-lite`; [`server/clause/milestones/evidence.ts`](./server/clause/milestones/evidence.ts) |

### Contest mode (`CLAUSE_CONTEST_MODE=true`)

The Firebase AI Logic contest requires generative AI to run through the Firebase AI Logic hybrid SDK. That SDK runs in the browser (and in the native apps); there is no server-side hybrid API, so the server can't honestly route a model call through it. With `CLAUSE_CONTEST_MODE=true` on the server:

- `server/clause/llm.ts` reports no provider and `callTool` refuses, so no Gemini REST or Anthropic call is made, even if `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` are set ([`server/clause/contest-mode.ts`](./server/clause/contest-mode.ts)).
- When the browser's Firebase AI Logic call can't run (no App Check token, quota, unsupported browser), the server fallback applies only its deterministic offline rules, badged **Offline rules**. Those rules read only the bundled samples; any other document gets a plain error instead of a model call.
- PDF proof goes inline to cloud Gemini through Firebase AI Logic in the browser (`ONLY_IN_CLOUD`), not to the server.
- The agent chat (a direct provider call) is hidden in the UI and refused server-side.
- `list-jobs` returns `runtime.contestMode`, so the UI's fallback messages say what happened.

The flag defaults to off, which keeps the original server providers. The hosted preview runs with it on. `test/contest-mode.test.ts` proves zero provider calls with both keys set.

### What leaves the device

| Mode | Document text / proof | What the server gets |
| --- | --- | --- |
| Hybrid (default), on-device model ready | Read by Gemini Nano in Chrome; nothing sent for reading | Structured terms when you create the job |
| Hybrid, long document or no on-device model | Sent to cloud Gemini through Firebase AI Logic (App Check) | Structured terms |
| Hybrid, Firebase AI Logic can't run | Sent to the Clause server: offline rules in contest mode, the server's own Gemini outside it (badge **Server**) | The raw text |
| Strict on-device (`only_on_device`: account menu toggle, `?ai=strict`, or Remote Config) | Read only by Gemini Nano. If `LanguageModel.availability()` isn't `available`, nothing is called and the UI says **"On-device model not available. Nothing was sent."** Errors never fall back to the cloud or the server. PDFs are refused. | Structured terms only. Proof files are still uploaded with the on-device verdict when you submit, for hashing and release binding |
| Offline | On-device if ready, otherwise **"Needs a connection. Nothing was sent."** A document read offline stays as a local draft; **Save draft** later sends only its terms | Nothing until you save |

`test/strict-on-device.test.ts` proves strict mode makes zero SDK, network or server-fallback calls when the local model is missing, downloadable or unavailable, including after runtime and schema errors.

- **Offline behavior:** When `navigator.onLine === false` and on-device inference is unavailable (or disabled by `ONLY_IN_CLOUD`), wrappers return a typed `"needs-connection"` result and the UI shows `"Needs a connection. Nothing was sent."` without guessing or contacting cloud/server endpoints.
- **Privacy & telemetry:** [`app/lib/ai-log.ts`](./app/lib/ai-log.ts) writes fire-and-forget metadata (`step`, `mode`, `inferenceSource`, `latencyMs`, `validatorOk`, `createdAt`) under `users/{uid}/aiCalls` with Firebase Anonymous Auth and [`firestore.rules`](./firestore.rules). Raw contract text, expense text, exception notes, and proof images are never stored in Firestore.

## Sandbox limits

- The Airwallex sandbox adapter can retry a trip card create or update with only `PER_TRANSACTION` when a request with both limits fails. Clause still stores and displays its planned `ALL_TIME` budget. Inspect the sandbox card's actual controls when verifying cumulative enforcement.
- A manager exception temporarily raises the card-wide per-charge limit for all allowed merchant categories. Clause restores the base cap immediately after an approved simulated purchase or before the next simulated purchase after the two-hour window expires.
- Airwallex sandbox uses its own clock. For future-dated expiry presets, Clause can temporarily move the sandbox card's validity window into the past and then attempts to restore it. The local mock evaluates the preset timestamp directly.
- Mock card and payout state lives in the app process. Jobs persist in SQL, so create a fresh job to get a usable mock card after restarting the server.
- Mock Metal verification reads in-memory state even when the UI says **Verify mandate on chain**. On-chain verification uses Metal testnet. The Airwallex deposit associated with a successful payout is a separate simulation.
- Frozen cards, closed cards, and insufficient wallet funds can produce declines without a source clause citation.

## Verified with Kane CLI

Every money-touching flow is checked in a real browser by [Kane CLI](https://www.testmuai.com/kane-cli/), and failures feed back to the coding agent. Kane caught two bugs that are now fixed (red → green). See [docs/KANE.md](docs/KANE.md) and `kane/`.

## How it works

- The model extracts document terms, reviews proof, and drafts change orders and exception requests. Code validates the extracted terms, computes card and payout controls, and maps provider outcomes to clauses when applicable.
- The owner or manager approves changes to spending power. A release must match its pending approval ID, milestone, and amount. The workspace supplies the evidence SHA-256 and currency, which the action checks when provided.
- The workspace and chat use typed actions in [`actions/`](./actions/). The job service lives in [`server/clause/`](./server/clause/) and stores jobs in the SQL `cl_jobs` table scoped by `owner_email`. See the [agent guide](./AGENTS.md) for the action reference and the [development guide](./DEVELOPING.md) for local checks and architecture.
