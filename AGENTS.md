# Clause — Agent Guide

Clause derives Airwallex virtual card controls from contractor quotes and from travel and expense policies with approved trip requests. Contractor jobs use milestone releases and a Metal payout mandate. Trip cards use a trip budget, a per-charge cap, and manager-approved exceptions. `/` redirects through sign-in to `/home` (the **Contract Jobs** workspace), which includes the contextual `AgentInspector`. `/chat` opens the full-screen chat entry, and `/chat/<threadId>` renders the conversation. See the [README](./README.md) for both demos and the [development guide](./DEVELOPING.md) for local setup.

## Skills

Search with `rg --hidden --follow`; read the exact linked guide before deeper work. `.agents/skills/adding-a-feature/SKILL.md` — cross-area feature checklist. Data/integrations: `.agents/skills/actions/SKILL.md`, `.agents/skills/storing-data/SKILL.md`, `.agents/skills/security/SKILL.md`, `.agents/skills/secrets/SKILL.md`, `.agents/skills/sharing/SKILL.md`. UI: `.agents/skills/frontend-design/SKILL.md`, `.agents/skills/shadcn-ui/SKILL.md`, `.agents/skills/client-side-routing/SKILL.md`. Agent context/workflows: `.agents/skills/context-awareness/SKILL.md`, `.agents/skills/real-time-sync/SKILL.md`, `.agents/skills/reliable-mutations/SKILL.md`, `.agents/skills/performance/SKILL.md`, `.agents/skills/delegate-to-agent/SKILL.md`. Framework: `.agents/skills/agent-native-docs/SKILL.md`, `.agents/skills/agent-native-toolkit/SKILL.md`, `.agents/skills/customizing-agent-native/SKILL.md`.

Use local docs only (no web research): `pnpm action docs-search --query "<topic>"`, `pnpm action docs-search --slug "<slug>"`, `pnpm action docs-search --list`, `pnpm action source-search --query "<pattern>"`, `pnpm action source-search --path <path>`, or `pnpm action source-search --list`.

## Core rules

- **Strict model / code / approver boundary**
  - The model reads quotes, policies and trip requests (`parse-quote`), milestone evidence (`submit-proof`), change-order emails (`draft-change-order`), and exception notes (`request-exception`). In chat, cite a `clause_id` when the action returns one. Describe operational declines such as frozen cards or insufficient wallet funds using the reported reason.
  - Deterministic code (`server/clause/policy/cardRules.ts`, `server/clause/milestones/service.ts`) computes all dollar limits, MCC allowlists, `active_to` deadlines, evidence SHA-256 bindings, and decline explanations. Never invent amounts or limits not returned by an action.
  - Invoke `approve-terms`, `approve-release`, `approve-change-order`, `approve-exception`, or `close-job` from chat only when the owner or manager explicitly directs that action in the conversation. Approval actions use the framework's human approval gate and owner-scoped job lookup. Trip issuance and exception approval also check the deployment's `CLAUSE_POLICY_APPROVER_EMAILS` list, with the built-in mock demo identity allowed in development and auth-disabled previews.
- **UI responsiveness:** Acknowledge user actions within 100 ms (never > 400 ms), reject overlapping mutations on the active slot, and allow client-side cancellation to free the slot.
- **Data & credentials.** `SqlJobStore` (`server/clause/store/sqlJobStore.ts`) scopes PostgreSQL/PGlite jobs in `cl_jobs` by the authenticated `owner_email`. Use the scoped vault for user credentials. `server/plugins/secrets.ts` registers `AWX_CLIENT_ID`, `AWX_API_KEY`, `AWX_CARDHOLDER_ID`, `GEMINI_API_KEY`, and `ANTHROPIC_API_KEY`. `server/clause/config.ts` resolves them for the active request via `resolveSecretDetailed` and supports deployment environment fallbacks for Airwallex and Gemini.
- **Branding:** Keep `server/plugins/agent-native-email-branding.ts` aligned (`app.name: "Clause"`, `app.homePath: "/home"`).

## Runtime limits

- **Airwallex.** The workspace uses an in-memory mock or the Airwallex sandbox. The adapter reads back sandbox controls after creating or updating a card and requires both `ALL_TIME` and `PER_TRANSACTION` for trip cards. On a failed readback or mismatched controls, it attempts to close a new card or freeze an existing card and reports the outcome. Use the issuer verification status from `get-job` when describing sandbox enforcement.
- **Policy exceptions.** Approval raises the card-wide per-transaction cap for merchants already allowed by the policy. The next approved simulated charge consumes the exception, even if that charge fits under the base cap. If two hours elapse first, `simulate-charge` restores the base cap before processing the next simulated charge after expiry.
- **Metal.** The default rail is an in-memory mock. Treat its “Verified on chain” label as a simulated result. Testnet mode invokes the Metal CLI for on-chain verification and can submit testnet payouts. Read the active Airwallex and Metal modes from `list-jobs` before describing results.
- **Milestone releases.** A durable approval claim records the stage and carries a stable payment ID. Repeating a completed approval returns its saved result. An interrupted or uncertain release keeps its claim for manual reconciliation and blocks a repeat payout and demo reset.

## Actions

The workspace uses `useActionQuery` and `useActionMutation` in `app/components/clause/ClauseJobWorkspace.tsx`. `server/plugins/agent-chat.ts` defines the agent's initial tools. `view-screen` and `navigate` use browser context, and the workspace exposes `reset-demo` through its sandbox tools.

| Action | HTTP | Args | Purpose |
| --- | --- | --- | --- |
| `list-jobs` | `GET` | `{}` | List the current user's contractor and policy jobs and report Airwallex, Metal, and model runtime info |
| `get-job` | `GET` | `{ jobId }` | Read the full `Job` document and the sandbox issuer's card status and control verification result |
| `parse-quote` | `POST` | `{ text?, useSample?, sampleKind? }` | Extract `ContractTerms` or `PolicyTerms` from pasted text or a bundled sample and create a draft with validation results. `sampleKind` is `contract` or `policy` |
| `approve-terms` | `POST` | `{ jobId }` | Issue a contractor card capped at the sum of signing milestones and bind its Metal mandate, or issue a trip card with the planned trip budget and per-charge cap |
| `simulate-charge` | `POST` | `{ jobId, preset?, amount?, merchantName?, mcc? }` | Simulate a preset or custom swipe and return a `DeclineExplanation` when declined, with a clause reference when applicable |
| `submit-proof` | `POST` | `{ jobId, files }` | Check evidence kinds, evaluate JPEG, PNG, or PDF files, and stage a `release_milestone` approval with the evidence SHA-256 |
| `approve-release` | `POST` | `{ jobId, approvalId, milestoneId, amount, currency?, evidenceSha256? }` | Match approval ID, milestone, and amount, plus currency and evidence hash when supplied. Raise the card's `ALL_TIME` cap and submit a Metal payout. A paid outcome triggers a best-effort simulated Airwallex deposit |
| `draft-change-order` | `POST` | `{ jobId, emailText?, useSample? }` | Draft a `ChangeOrderProposal` from contractor email and stage a `change_order` pending approval |
| `approve-change-order` | `POST` | `{ jobId, approvalId }` | Apply the change order, recompute Airwallex controls, and replace the Metal mandate if its payout cap or budget increases |
| `request-exception` | `POST` | `{ jobId, note?, useSample?, requestedCap? }` | Evaluate the entertainment note and stage a `policy_exception` bounded by the policy's per-attendee cap times the number of eligible named attendees |
| `approve-exception` | `POST` | `{ jobId, approvalId }` | Apply the manager-approved per-charge override and set its two-hour expiration. Simulated charges run the restoration logic |
| `metal-overpay-attempt` | `POST` | `{ jobId }` | Attempt a payout at twice the mandate cap to demonstrate a clause-cited `mandate_cap_exceeded` refusal |
| `metal-wrong-payee` | `POST` | `{ jobId }` | Attempt a payout to an unlisted address to demonstrate a clause-cited `mandate_payee_not_listed` refusal |
| `metal-verify` | `POST` | `{ jobId }` | Verify the mandate in the configured Metal mode and record payment and refusal counts |
| `reject-pending` | `POST` | `{ jobId, reason? }` | Reject the current pending milestone release, change order, or policy exception without modifying card controls |
| `freeze-card` | `POST` | `{ jobId, frozen }` | Toggle Airwallex card between `INACTIVE` (frozen) and `ACTIVE` |
| `close-job` | `POST` | `{ jobId }` | Permanently close the Airwallex virtual card (`CLOSED`) and mark job `closed` |
| `reset-demo` | `POST` | `{}` | Delete every job owned by the current user, including custom jobs, and clear the process-wide Airwallex and Metal mocks. Pending release reconciliation blocks reset. Previously issued sandbox cards and testnet artifacts persist |
| `view-screen` | `false` | `{}` | Return `navigation`, `runtime`, `activeJob` summary + recent transactions for `<current-screen>` |
| `navigate` | `false` | `{ view, path?, threadId? }` | Navigate current browser tab (`home` / `jobs` -> `/home`, `chat` -> `/chat`) |

## Application state & UI selectors

- `navigation` tracks `{ view, path, publicPath, jobId?, threadId? }` via `app/hooks/use-navigation-state.ts`; selected job is synced to `/home?job=<jobId>`.
- Stable DOM hooks on `/home` (`app/components/clause/ClauseJobWorkspace.tsx`): `#parse`, `#approveTerms`, `[data-charge]`, `#proofFiles`, `#proofKind`, `#submitProof`, `#draftCo`, `#approveRelease`, `#approveCo`, `#requestException`, `#approveException`, `#expenseReport`, `#exportReport`, `#metalPanel`, `#metalSpent`, `#metalEvents`, `#metalOverpay`, `#metalWrongPayee`, `#metalVerify`, `#resetDemo`.

## Verification

Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm agent-native:doctor` — fix all findings before finishing.
