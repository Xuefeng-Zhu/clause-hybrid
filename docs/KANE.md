# Verified with Kane CLI

Clause Hybrid lets AI read contracts, receipts, change orders and proof photos, but money only moves through deterministic card rules and human approval. Kane CLI (TestMu AI) checks the browser workflows that depend on that promise: plain-English flows run in a real Chrome, pass or fail.

## Quick start: one flow

```bash
corepack pnpm install --frozen-lockfile
AUTH_DISABLED=true corepack pnpm dev        # prints e.g. "➜  Local:   http://localhost:8080/"
npm i -g @testmuai/kane-cli && kane-cli login
KANE_URL=http://localhost:8080/home kane/run-flows.sh 02
```

Use the URL your dev server prints, plus `/home` (Vite defaults to 8080 and picks the next free port if 8080 is taken). `AUTH_DISABLED=true` gives the local app a shared test identity (`dev@local.test`), so Kane lands straight in the workspace; without it, choose **Continue as local dev** first. No provider keys are needed: without Firebase config or a Gemini key, the app uses its deterministic card rules and offline rules.

Flow 02 is the one that found the real bug (below). Then run all four Kane flows with `kane/run-flows.sh`. Each flow spends Kane credits. Results are written to `kane/out/<flow>.ndjson`, and failures to `kane/out/FAILURES.md`.

**Rejected-photo fixture (flow 04):** `kane/fixtures/stock-not-job-site.jpg`, a generated placeholder image (made with ImageMagick for this repo, no third-party content). It is the default `KANE_PROOF_FILE`. With no model configured, the server's offline proof rule rejects any filename containing `stock` or `wrong` (`server/clause/milestones/evidence.ts`), so this fixture gets `Doesn’t meet requirements`. Any other filename passes the offline rule, which is why the name matters. With a live model, the model judges the image itself; this generated fixture has not been run against a live model.

## What is and isn't Kane

Three different kinds of checks back this project. Only the first is Kane.

| Check | What ran | Where it's recorded |
|---|---|---|
| **Browser workflow checks (Kane CLI)** | Flows 01–04 below, in Kane's headless Chrome. That browser has no Gemini Nano, so Kane exercised the cloud path, the server path and the offline rules, **never on-device inference**. | This file |
| **Real-device inference runs (not Kane)** | Gemini Nano ran the sample quote in desktop Chrome on a CPU-only Linux VM (Nov 15, about 80–90 s per parse vs about 3 s for cloud Gemini). Android builds ran on Firebase Test Lab Pixels (Pixel 9, Pixel 10 Pro), where the cloud path worked and Nano was unavailable. | Run logs are in the author's project notes, not this repo; device requirements in `apps/mobile/README.md` |
| **Release-attestation and privacy checks (not Kane)** | App Check fail-closed behaviour, the unattested-request 401, strict on-device "nothing was sent", contest mode, and the production-bundle grep for debug tokens, checked with Vitest (`test/app-check-fail-closed.test.ts`, `test/strict-on-device.test.ts`, `test/contest-mode.test.ts`), Chrome DevTools Protocol scripts and curl. | README "Contest mode" and "What leaves the device", `test/` |

Flow 05 (offline) is also not Kane: kane-cli 0.10.4 has no network emulation, so it was checked by hand by setting Chrome offline over the DevTools Protocol.

## Flows

| # | Run by | What it asserts |
|---|---|---|
| 02 | Kane | `$6,000 Declined — Over released limit §1.1`; **Explain** opens an inline explanation (`data-testid="decline-explanation"`), not a chat panel, with a source badge and `Nothing was paid. Card rules decided this, not AI.`; header still `Released $4,000` |
| 01 | Kane | Quote → $12,000 contract, $4K/$5K/$3K milestones, Dec 18 2026 deadline, source badge (`Cloud ·`, `On-device ·`, `Server ·` or `Offline rules`), `Released $4,000` |
| 03 | Kane | Sample change order (in-stock quartz, +$800 on Milestone 2): `$12,000 → $12,800 (+$800)`, deadline Dec 18 → Dec 23, source badge, waits on Approve/Reject, totals unchanged |
| 04 | Kane | Rejected proof photo: `Doesn’t meet requirements` (either apostrophe), source badge, chip `Proof rejected` (not `Proof received`), `Held $5,000` (not `+$5,000`), disabled button `… $5,000 stays locked`, header `Released $4,000` |
| 05 | Manual (DevTools) | Offline: `Needs a connection. Nothing was sent.` |

## What Kane caught

### The catch: an explanation that explained nothing (flow 02, Nov 15)

On the hosted preview, Kane issued the card and posted a $6,000 charge from Builders Supply Co. against the $4,000 released so far. The card rules did their job: `Builders Supply Co. $6,000 Declined — Over released limit §1.1`, header still `Released $4,000 · Spent $0`, Milestone 2 still awaiting proof.

Then Kane clicked **Explain** (aria-label `Ask Clause about this decline`). Instead of an explanation, it opened the general chat panel, which had no AI connected: `Connect AI / Use Builder.io / Custom keys`, with the message box disabled. No explanation, no source badge, after 30+ seconds of waiting. Money was safe, but the one button meant to tell the user why was a dead end.

Kane's runner crashed both times while waiting on that panel (`v16-runner exited unexpectedly`), so those attempts left no Test Manager link; the result was read from the page in Kane's own browser. Flows 01, 03 and 04 passed in that run.

### The fix (commit [`22daf67`](https://github.com/Xuefeng-Zhu/clause-hybrid/commit/22daf676))

- **Explain answers inline.** `app/lib/clause-ai/decline.ts` asks Firebase AI Logic hybrid inference to restate the deterministic decline facts in plain words. A validator rejects any explanation that invents an amount or says money will move, and the card-rule text is shown instead (badge `From the card rules`). Every explanation ends with `Nothing was paid. Card rules decided this, not AI.`
- Four new Vitest tests in `test/decline-explain.test.ts`; 75/75 passed.

### The passing rerun

- **Nov 16, local production build of `22daf67`:** flow 02 **passed** on the first attempt. Explain opened the inline box under the declined row, with `From the card rules` and `Nothing was paid. Card rules decided this, not AI.`, and no chat panel. No model key was available that night, so the explanation text came from the card-rule fallback, not Gemini.
- **Nov 23, hosted preview with live Gemini:** flow 02 **passed** again, same inline box and badge.

### Flow 04: a passing test with the wrong words

Flow 04 **passed** on Nov 15: the photo got `Doesn’t meet requirements` and the release button stayed disabled. But the page it passed on still read `Proof received` and `+$5,000`, with a button labelled `Milestone 2 proof received — Approve release $5,000`. No money could move, yet the wording said the proof was accepted. The original flow didn't check that wording, so it couldn't fail on it.

`22daf67` changed the copy (`Proof rejected`, `Held $5,000`, `$5,000 stays locked`), and flow 04 now asserts all of it: the chip must read `Proof rejected` and must not read `Proof received`, the amount must read `Held $5,000` and not `+$5,000`, and the disabled button must say `$5,000 stays locked`. The stronger flow passed on Nov 16 (offline rule rejection, filename containing `stock`). On Nov 23 the app showed the same correct wording with a live-Gemini rejection, but Kane failed that run on a straight vs curly apostrophe in the flow text, now fixed (`94d3032`, `02857ea`).

### Run 3: the missing source badge (Nov 23)

The first Kane run against a preview with live Gemini. In Kane's headless Chrome, App Check rejected the browser's Firebase AI Logic call (`AppCheck: 403`, then a 24 h throttle), so the server did the work with Gemini. Flow 01 **failed**: the quote review, change-order dialog and proof verdict showed **no source badge** for server output, although the UI says the badge tells you which model ran.

**Fix:** server AI steps now return their model, latency and `parsedBy`, and the UI badges them `Server · <model> · <latency>` or `Offline rules` (`c23384f`). Flow 03 now matches the app's quartz sample email, and flow 01 dropped a late extraction step that failed on its own (`02857ea`, `ab35951`).

**Verification:** with an App Check debug token injected into the test browser only, Kane ran flow 01 again and it **passed** with the badge `Cloud · gemini-3.5-flash-lite · 3.2 s`. Server-path output on the same preview showed `Server · gemini-3.8-flash · 2.7 s` (checked over DevTools, not Kane).

### Run 4: a full run and a real FAILURES.md hand-off (Nov 24)

**Target: a local production build of `077e0d7`** (`http://127.0.0.1:8787/home`, `AUTH_DISABLED=true`, PGlite, no Firebase config, no model keys), not the hosted preview. The preview's Google Cloud lab account was deleted, so the Cloud Run service and Hosting channel return 503 and could not be redeployed. With no Firebase config and no model keys, every AI step took the **offline rules** (badge `Offline rules`); no cloud model and no on-device model ran in this run. Kane drove a headless Chrome for Testing over CDP. kane-cli 0.10.4, run with `kane/run-flows.sh` (no sleep hack).

Before the run, the sample travel trip from the date fix in `077e0d7` was checked on the same build over the action API: `hotel` and `uber` charges approved, `dinner`, `bar`, `bestbuy` and `late` declined with their § reasons.

| # | First run | After the loop | Credits | Kane link |
|---|---|---|---|---|
| 01 | **FAIL**: flow text, not the app | **PASS** | 45.7, then 29.4 | [run 1](https://test-manager.lambdatest.com/projects/01M79MD0W5S8Y89MBQ81NBW302/test-cases/01M87VSSSC9E10HTJYK6KS9FZR/dashboard/share/US_6YKCUDLE3Y2732V5729S52PX743TL74GOGTMM27NJSESJ7CLU1YBSMV4VN9F6TBO?type=summary&agentView=true&fqdn=summary-page) · [rerun](https://test-manager.lambdatest.com/projects/01M79MD0W5S8Y89MBQ81NBW302/test-cases/01M87Y0WQ05DZJK5CB224JZFTF/dashboard/share/US_Z5V3E6312D46LZBJLYJGY7ADD2G5MN86RCTN7O7MWE6ZFDLMLM6YOL95YFA7MBR8?type=summary&agentView=true&fqdn=summary-page) |
| 02 | **PASS**: `$6,000 Declined Over released limit §1.1`, inline explanation with `From the card rules` and `Nothing was paid. Card rules decided this, not AI.`, header `Released $4,000` | not rerun | 57.2 | [run](https://test-manager.lambdatest.com/projects/01M79MD0W5S8Y89MBQ81NBW302/test-cases/01M87VZ89FW5ZXFF1XH1B4W2R9/dashboard/share/US_TPN4W9575PZ3MVJXD908KLSKAXLE4UHHSE3WA19UZMN0OLXLPKQ1X8Z69WI9PHX0?type=summary&agentView=true&fqdn=summary-page) |
| 03 | **PASS**: `$12,000 → $12,800 (+$800)`, Dec 18 → Dec 23, waits on Reject / Approve, header unchanged | not rerun | 30.6 | [run](https://test-manager.lambdatest.com/projects/01M79MD0W5S8Y89MBQ81NBW302/test-cases/01M87W6SZ0D513ZYFCN2E7HW78/dashboard/share/US_AUXLYET7ISLAY0WIR67WFX05LL943SFPX11446EXWNQMQR71Y6TEWW2OUWOS8OH0?type=summary&agentView=true&fqdn=summary-page) |
| 04 | **PASS**: `Doesn’t meet requirements` (`Offline rules`), `Proof rejected`, `Held $5,000`, disabled `… $5,000 stays locked`, header `Released $4,000` | not rerun | 48.7 | [run](https://test-manager.lambdatest.com/projects/01M79MD0W5S8Y89MBQ81NBW302/test-cases/01M87WCPZZY4RTBMJHKEYQA4KX/dashboard/share/US_TLRW4JZ9I0MVP5954WR4A9XG5S6A1CVXJF7T5Q5T0IU4464DUAWZHUROWPO2Z60Z?type=summary&agentView=true&fqdn=summary-page) |

Balance 8,655.44 → 8,403.10 credits (252.3 used; the runs report 211.6, the rest is balance overhead). Flow 03 used the job an earlier flow had left active, which its text allows.

**Flow 01's failure was in the test, not the app.** Every explicit assertion passed (`$12,000`, `$4,000`/`$5,000`/`$3,000`, `Dec 18, 2026`, `Offline rules`, `Released $4,000`). Kane then turned the closing sentence "Fail the test if any of these texts are missing." into a checkpoint with an empty text list and stopped (`assertion_error.step_not_achievable`). Kane's own verdict: `automation_bug` / `config_issue`, "a malformed test/checkpoint configuration rather than a bad browser action".

**The hand-off.** `kane/run-flows.sh` wrote `kane/out/FAILURES.md`. That file and `kane/AGENT_LOOP.md` went to **Codex CLI** (0.171.0, `gpt-6.2-astra`, high reasoning, `codex exec`), told to decide honestly between an app bug and a flow-text bug and not to run Kane itself. Codex read Kane's step log and concluded:

> Kane passed every explicit assertion, including the release header after card issuance. Step 14 failed on the trailing "any of these texts" instruction because Kane had no list for that checkpoint. I'll remove just that sentence.

Codex removed that one sentence from `kane/flows/01-quote-to-terms.txt`; every explicit assertion stayed. Vitest 122/122 and `tsc --noEmit` were clean (Codex ran them, and they were run again independently afterwards). Commit [`db51d20`](https://github.com/Xuefeng-Zhu/clause-hybrid/commit/db51d20) notes Codex as the author. Only flow 01 was rerun, on a fresh store and a fresh browser profile, and it **passed** in 281 s.

So the loop ran end to end with a real `FAILURES.md`, but what it fixed was the test, not the product. Flows 02 and 04 end with similar catch-all sentences and passed this time; they were left unchanged because they were not rerun.

## How the fixes were made (the loop, honestly)

The loop that produced `22daf67` was: Kane ran the flows → an AI coding agent read Kane's results and the page Kane was stuck on → the agent wrote the fix and tests (`tsc`, Vitest 75/75) → Kane re-ran only the failed flows. The agent for this fix was **Hark** (the AI agent Frank used for this project), not Antigravity; no Antigravity session was involved in this fix. Antigravity (Gemini) built an earlier part of the app (the Phase 2 hybrid wrappers), not the Kane fixes.

There is no `FAILURES.md` from that night: `kane/run-flows.sh`, `kane/AGENT_LOOP.md` and the `FAILURES.md` hand-off were written right after the fix (commit `28a99d5`), to turn the same steps into a repeatable script any coding agent can follow.

| Step | Time (PST) | What happened |
|---|---|---|
| Failing step | Nov 15, 22:27–23:01 | Kane flow 02: Explain opens an unconnected chat; runner crashes waiting on it |
| What the agent got | 23:03 | Kane's per-flow results, the exact UI text from Kane's browser, and the two findings |
| Fix | 23:28 | `22daf67` pushed: inline Explain + validator, rejected-proof wording, 4 tests, 75/75 |
| Passing rerun | Nov 16, 00:19–00:33 | Kane flows 02 and 04 pass on a local build of `22daf67` |

## Running it yourself

See [Quick start](#quick-start-one-flow). Options: `KANE_PROOF_FILE` (flow 04 image), `KANE_MAX_STEPS` (default 30), `KANE_CDP` (attach to an existing Chrome over CDP). The Nov 16 runs used a local production build served on port 8787, which is why older notes show `127.0.0.1:8787`; with `pnpm dev`, use the port it prints.
