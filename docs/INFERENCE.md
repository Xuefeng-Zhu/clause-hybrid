# Hybrid inference and data flow

Clause uses [Firebase AI Logic](../app/lib/hybrid-ai.ts) in the browser for document extraction and evidence review. Chrome can run Gemini Nano on-device. The default cloud model is `gemini-3.5-flash-lite`, configurable at build time through `VITE_CLOUD_MODEL`. The workspace shows the source of a result as **On-device**, **Cloud**, **Server**, or **Offline rules**. Card rules and payout amounts are computed from validated terms, and approval is a separate action.

## Inference by task

[Firebase Remote Config](../app/lib/firebase.ts) can override the defaults in the table. For contractor quotes and travel policies, the default `prefer_on_device` switches to `prefer_in_cloud` above `parse_cloud_char_threshold` (6,000 characters by default).

| Task | Remote Config key | Default | Validation |
| --- | --- | --- | --- |
| Contractor quote | `contract_mode` (legacy `parse_mode`) | `prefer_on_device` | Renumbers duplicate milestone IDs, flags non-verbatim quotes, and validates terms. [Browser wrapper](../app/lib/clause-ai/parse.ts) |
| Travel policy and trip | `expense_mode` | `prefer_on_device` | Checks dates, the 48-hour expiry rule, and the relationship between the per-charge cap and trip budget. [Browser wrapper](../app/lib/clause-ai/expense.ts) |
| Travel exception | `exception_mode` | `prefer_on_device` | Computes the proposed cap from the policy's per-attendee limit and the eligible named attendees. [Browser wrapper](../app/lib/clause-ai/exception.ts) |
| Change order | `changeOrder_mode` | `prefer_in_cloud` | Validates the proposed changes and computes the new milestone and contract amounts. [Browser wrapper](../app/lib/clause-ai/changeOrder.ts) |
| Milestone proof | `evidence_mode` | `prefer_in_cloud` | Checks required file kinds and validates the verdict. The browser downscales one primary image to JPEG for inference. The server hashes the original evidence to bind it to the approval. [Browser wrapper](../app/lib/clause-ai/evidence.ts) · [Release service](../server/clause/milestones/service.ts) |

## Contest mode

Set `CLAUSE_CONTEST_MODE=true` to disable direct server model calls and agent chat. The linked preview uses this mode. When browser inference is unavailable, the server uses deterministic rules. Quote and policy extraction from that fallback is limited to bundled samples. Offline proof checks use declared evidence kinds and a filename heuristic. Outside contest mode, a configured server can use Gemini, or Claude when Gemini is unconfigured. [Server providers](../server/clause/llm.ts) · [Contest-mode tests](../test/contest-mode.test.ts)

## App Check

A production web build needs `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY` to enable cloud inference. With Firebase configured and the site key missing, the app reports **App Check not configured: cloud AI disabled**. It can still use Chrome's on-device model when ready and fall back to offline rules as applicable. App Check debug tokens are development-only. [Environment settings](../.env.example) · [App Check tests](../test/app-check-fail-closed.test.ts)

## What leaves the browser

| Inference path | Document or proof handling |
| --- | --- |
| On-device | Gemini Nano reads the input in Chrome. Creating a job sends extracted terms, including cited excerpts, to Clause. Submitting milestone proof sends the original files and the verdict for evidence hashing and approval binding. |
| Cloud | The browser sends the inference input to cloud Gemini through Firebase AI Logic. PDF proof uses this path for browser inference. Clause receives extracted terms or the submitted proof as described above. |
| Server fallback | Clause receives the original input when browser inference fails or is unavailable in hybrid mode. In contest mode it uses deterministic rules. Outside contest mode a configured server model can evaluate the input, including proof files. |
| Strict on-device | Use **Strict on-device** in the workspace account menu, `?ai=strict`, or `only_on_device` for a task in Remote Config. The browser skips cloud and server inference. If the local model is unavailable or a task cannot run locally, the app explains that the input was not sent. This mode refuses PDF proof. |
| Offline | When on-device inference is available for the task, a document can become a local draft. After reconnecting, **Save draft** sends the extracted terms. If local inference is unavailable, the UI shows **Needs a connection. Nothing was sent.** |

When Firebase is configured, Clause can log the task, mode, inference source, latency, and validation result in Firestore under `users/{uid}/aiCalls`, using Firebase Anonymous Auth. The log contains metadata only. [Telemetry writer](../app/lib/ai-log.ts) · [Firestore rules](../firestore.rules)

For runtime setup, see the [development guide](../DEVELOPING.md). For browser and physical-device coverage, see the [Kane runbook](KANE.md) and the [Expo app guide](../apps/mobile/README.md).
