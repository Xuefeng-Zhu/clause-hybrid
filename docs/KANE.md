# Verified with Kane CLI

Clause Hybrid lets AI read contracts, receipts, change orders and proof photos, but money only moves through deterministic card rules and human approval. Kane CLI (TestMu AI) checks that promise in a real browser: plain-English flows, pass or fail, and every failure goes back to the coding agent.

## The loop

1. `kane/run-flows.sh` runs the flows in `kane/flows/` against the app (hosted preview or `localhost`).
2. Failures land in `kane/out/FAILURES.md` with Kane's last steps.
3. The coding agent gets `kane/AGENT_LOOP.md` as its prompt: fix, add a test, run `tsc` and `vitest`, then re-run only the failed flows.
4. Repeat until green (two attempts per flow, max).

## Flows

| # | Flow | What Kane asserts |
|---|------|-------------------|
| 01 | Quote → terms | $12,000 contract, $4K/$5K/$3K milestones, Dec 18 2026 deadline, source badge (`Cloud ·`, `On-device ·`, `Server ·` or `Offline rules`), `Released $4,000` |
| 02 | Over-limit charge → Explain | `$6,000 Declined — Over released limit §1.1`, inline explanation, `Nothing was paid. Card rules decided this, not AI.`, no funds released |
| 03 | Change order (sample email: in-stock quartz, +$800 on Milestone 2) | `$12,000 → $12,800 (+$800)`, deadline Dec 18 → Dec 23, source badge, waits on Approve/Reject, totals unchanged |
| 04 | Rejected proof photo | `Doesn’t meet requirements` (either apostrophe accepted), source badge, `Proof rejected`, `Held $5,000`, `$5,000 stays locked` |
| 05 | Offline | `Needs a connection. Nothing was sent.` (manual CDP check: kane-cli 0.10.4 has no network emulation) |

## What Kane caught (Nov 15–23, 2026)

**Run 1, hosted preview (Nov 15):** flows 01, 03 and 04 passed. Kane found:

- **High:** the decline **Explain** button opened an agent chat with no AI connected, so it never explained anything (and the panel crashed Kane's runner).
- **Medium:** after a rejected proof, the UI still said `Proof received` and `+$5,000`, with a button reading `Milestone 2 proof received — Approve release $5,000`. No money could move (the button was disabled), but the wording said the proof was accepted.

**Fix (commit `22daf67`):**

- Explain now answers inline through Firebase AI Logic hybrid inference (`app/lib/clause-ai/decline.ts`). A deterministic validator rejects any explanation that invents an amount or promises payment, and the card-rule text is shown instead.
- Rejected proofs read `Proof rejected`, `Held $5,000` and `$5,000 stays locked`.
- Four new Vitest tests; 75/75 pass.

**Run 2, after the fix (Nov 16):** flows 02 and 04 **passed** on the first attempt: red → green. This run used a local build with offline AI fixtures, so the explanation came from the card-rule fallback (`From the card rules`).

**Run 3, live-Gemini preview (Nov 23):** the first run against the Cloud Run preview with a real `GEMINI_API_KEY` (Runs 1–2 used offline fixtures). In Kane's headless Chrome, App Check rejected the browser's Firebase AI Logic call (`AppCheck: 403`, then a 24 h throttle), so the server did the work with Gemini. The fallback worked, but:

- **Medium:** the quote review, the change-order impact dialog and the proof verdict showed **no source badge** for server output, although the UI says "the badge says which ran".
- **Low (spec):** flow 03 expected an LED +$1,500 email, but `Use sample email` loads the quartz +$800 email. Flow 04 failed on a straight vs curly apostrophe.

**Fix (Nov 23):** server AI steps now return their model, latency and `parsedBy`, and the UI badges them `Server · <model> · <latency>`, or `Offline rules` when the offline fixture ran. Flow 03 now matches the quartz sample, and the app uses one apostrophe style. For the verification run, the test browser (only) got the App Check debug token, so Kane exercised the browser AI Logic path: flow 01 **passed** with `Cloud · gemini-3.5-flash-lite · 3.2 s`. Server-path output on the same preview now shows `Server · gemini-3.8-flash · 2.7 s` (checked over CDP, not Kane).

## Running it yourself

```bash
npm i -g @testmuai/kane-cli && kane-cli login
KANE_URL=http://127.0.0.1:8787/home KANE_PROOF_FILE=/path/to/unrelated-photo.jpg kane/run-flows.sh
```

Flow 04 needs a photo that is *not* of the job site, so the evaluator rejects it. With offline fixtures, use a filename that contains `stock`.
