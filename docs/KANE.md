# Browser verification with Kane CLI

Kane CLI found a broken **Explain** button after Clause correctly declined a $6,000 charge against a $4,000 limit. The rerun verified that Clause now shows an inline explanation grounded in the card rules. [Finding and reruns](#flow-02-decline-explanations)

## Quick start

From the project root, start the web app with the shared local test identity. With no provider credentials configured, the bundled samples use offline rules and mock card and payout providers.

```bash
corepack pnpm install --frozen-lockfile
AUTH_DISABLED=true corepack pnpm dev
```

In a second terminal, install Kane CLI, sign in, and run the decline explanation flow. Use the URL printed by the dev server, with `/home` appended.

```bash
npm install -g @testmuai/kane-cli
kane-cli login
KANE_URL=http://localhost:8080/home kane/run-flows.sh 02
```

Each run uses Kane credits. Omit the flow number to run 01–04. The runner saves results to `kane/out/<flow>.ndjson` and writes failed steps to `kane/out/FAILURES.md` for the [coding-agent hand-off](../kane/AGENT_LOOP.md).

For travel, run flow 06 against an isolated mock preview. It creates a new trip job and leaves it in that workspace.

```bash
KANE_URL=http://localhost:8080/home KANE_MAX_STEPS=45 kane/run-flows.sh 06
```

| Option | Use |
| --- | --- |
| `KANE_URL` | Workspace URL, including `/home`. Default is `http://localhost:8080/home`. |
| `KANE_MAX_STEPS` | Browser step limit. Default is 30. |
| `KANE_CDP` | Connect Kane to an existing Chrome instance over the DevTools Protocol. |
| `KANE_PROOF_FILE` | File for flow 04. Defaults to the [generated test photo](../kane/fixtures/stock-not-job-site.jpg). |

The default flow 04 photo was generated with ImageMagick for this repo. Offline proof review checks required evidence kinds, then flags filenames containing `stock`, `wrong`, or `blurry`. A live model reviews the image itself. [Offline evaluator](../server/clause/milestones/evidence.ts)

## Flows

| Flow | Verification | What it checks |
| --- | --- | --- |
| [01 · Quote to terms](../kane/flows/01-quote-to-terms.txt) | Kane | $12,000 contract, $4,000 / $5,000 / $3,000 milestones, Dec 18, 2026 deadline, inference source badge, and $4,000 released. |
| [02 · Decline explanation](../kane/flows/02-decline-explain.txt) | Kane | $6,000 decline cites §1.1, **Explain** opens inline with a source badge, and the released amount stays at $4,000. |
| [03 · Change order](../kane/flows/03-change-order.txt) | Kane | The quartz change order proposes +$800 and moves the deadline from Dec 18 to Dec 23. Totals stay at their original values while approval is pending. |
| [04 · Rejected proof](../kane/flows/04-proof-rejected.txt) | Kane | `Doesn’t meet requirements`, a source badge, `Proof rejected`, `Held $5,000`, and a disabled release control. The released amount stays at $4,000. |
| [05 · Offline](../kane/flows/05-offline.txt) | Manual Chrome DevTools | `Needs a connection. Nothing was sent.` The Kane CLI 0.10.4 runner lacks network emulation for this check. |
| [06 · Travel exception and CSV](../kane/flows/06-travel-exception-csv.txt) | Manual check in Chrome on a local mock build. Not yet run with Kane. | One $480 dinner is approved after a $500 exception, the $300 base cap returns, the other two attempts decline, and CSV export is confirmed with $0 owed. Vitest checks the CSV contents. |

### Inference and privacy checks

| Check | Evidence |
| --- | --- |
| Kane browser runs | Headless Chrome exercised cloud inference, server inference, and offline rules across the recorded runs. Gemini Nano was unavailable in that browser. |
| Device inference | On Nov 15, Gemini Nano parsed the sample quote in 80–90 seconds on a CPU-only Linux VM, with cloud Gemini taking about 3 seconds. The Firebase Test Lab runs on Pixel 9 and Pixel 10 Pro exercised cloud inference. Nano was unavailable on those devices. Device-run logs are in the author's project notes. [Mobile setup](../apps/mobile/README.md) |
| App Check and fallback | Vitest, Chrome DevTools Protocol scripts, and curl checked missing App Check configuration, HTTP 401 for unattested requests, strict on-device behavior, contest mode, and the absence of the debug token from the production bundle. [App Check tests](../test/app-check-fail-closed.test.ts) · [Strict on-device tests](../test/strict-on-device.test.ts) · [Contest mode tests](../test/contest-mode.test.ts) |

## Findings and reruns

### Flow 02 decline explanations

On Nov 15, Kane issued a card on the hosted preview and submitted a $6,000 charge from Builders Supply Co. Clause correctly declined the charge under §1.1. The header still read `Released $4,000 · Spent $0`, and milestone 2 was still awaiting proof.

**Explain** opened the general chat panel, which displayed its provider setup and disabled the message box. Kane waited more than 30 seconds for an explanation and source badge. The runner crashed on both attempts with `v16-runner exited unexpectedly`, so the findings came from Kane's browser and have no Test Manager links. Flows 01, 03, and 04 passed in that run.

Hark changed **Explain** to open below the declined transaction. Firebase AI Logic can restate the card-rule facts. A validator falls back to the card-rule text, badged **From the card rules**, if the model invents an amount or promises a payment. The panel ends with `Nothing was paid. Card rules decided this, not AI.` Four new Vitest tests brought that run to 75 passing tests. [Fix `22daf67`](https://github.com/Xuefeng-Zhu/clause-hybrid/commit/22daf676) · [Explanation tests](../test/decline-explain.test.ts)

- **Nov 16, local production build of `22daf67`.** Flow 02 passed on the first attempt. The inline panel showed **From the card rules** with the provider keys absent.
- **Nov 23, hosted preview with live Gemini.** Flow 02 passed again with the inline panel and source badge.

### Flow 04 rejected-proof wording

Flow 04 passed on Nov 15 because the photo was marked `Doesn’t meet requirements` and the release button was disabled. The screen also showed `Proof received`, `+$5,000`, and an approval label that implied the proof was accepted. The original flow missed those labels.

`22daf67` changed the copy to `Proof rejected`, `Held $5,000`, and `$5,000 stays locked`. The stricter flow passed with the offline photo fixture on Nov 16. On Nov 23, live Gemini rejected the photo and the app showed the expected wording. Kane failed that run on an apostrophe mismatch, addressed in `94d3032` and `02857ea`.

### Nov 23 source badges

On the first live-Gemini run, App Check rejected Firebase AI Logic in Kane's headless browser with HTTP 403 and a 24-hour throttle. The preview used server Gemini. Flow 01 failed because the quote review, change-order dialog, and proof verdict lacked source badges for server output.

`c23384f` added model, latency, and `parsedBy` data for the `Server · <model> · <latency>` and `Offline rules` badges. `02857ea` and `ab35951` updated flow 03 to match the quartz sample and removed an independent late extraction step from flow 01.

With an App Check debug token injected only into the test browser, Kane reran flow 01 and confirmed `Cloud · gemini-3.5-flash-lite · 3.2 s`. A separate DevTools check on the same preview confirmed `Server · gemini-3.8-flash · 2.7 s`.

### Nov 24 full run and failure hand-off

The earlier Google Cloud lab account had been deleted, and its Cloud Run service and Hosting channel returned HTTP 503. Kane CLI 0.10.4 used a local production build of `077e0d7` at `http://127.0.0.1:8787/home`, with `AUTH_DISABLED=true`, PGlite, and the offline rules. The runner was `kane/run-flows.sh` with Chrome for Testing over CDP. The port in the results below was specific to that local build.

An action API check of the same build confirmed the sample date fix. Hotel and rideshare presets were approved, while dinner, bar, Best Buy, and late rideshare presets were declined with policy citations.

| # | First run | After the loop | Credits | Kane link |
|---|---|---|---|---|
| 01 | **Fail** on the closing checkpoint | **Pass** | 45.7, then 29.4 | [First run](https://test-manager.lambdatest.com/projects/01M79MD0W5S8Y89MBQ81NBW302/test-cases/01M87VSSSC9E10HTJYK6KS9FZR/dashboard/share/US_6YKCUDLE3Y2732V5729S52PX743TL74GOGTMM27NJSESJ7CLU1YBSMV4VN9F6TBO?type=summary&agentView=true&fqdn=summary-page) · [Rerun](https://test-manager.lambdatest.com/projects/01M79MD0W5S8Y89MBQ81NBW302/test-cases/01M87Y0WQ05DZJK5CB224JZFTF/dashboard/share/US_Z5V3E6312D46LZBJLYJGY7ADD2G5MN86RCTN7O7MWE6ZFDLMLM6YOL95YFA7MBR8?type=summary&agentView=true&fqdn=summary-page) |
| 02 | **Pass** with a §1.1 decline, an inline explanation badged `From the card rules`, and $4,000 still released | — | 57.2 | [Run](https://test-manager.lambdatest.com/projects/01M79MD0W5S8Y89MBQ81NBW302/test-cases/01M87VZ89FW5ZXFF1XH1B4W2R9/dashboard/share/US_TPN4W9575PZ3MVJXD908KLSKAXLE4UHHSE3WA19UZMN0OLXLPKQ1X8Z69WI9PHX0?type=summary&agentView=true&fqdn=summary-page) |
| 03 | **Pass** with the $800 proposal, Dec 23 deadline, and original totals while approval was pending | — | 30.6 | [Run](https://test-manager.lambdatest.com/projects/01M79MD0W5S8Y89MBQ81NBW302/test-cases/01M87W6SZ0D513ZYFCN2E7HW78/dashboard/share/US_AUXLYET7ISLAY0WIR67WFX05LL943SFPX11446EXWNQMQR71Y6TEWW2OUWOS8OH0?type=summary&agentView=true&fqdn=summary-page) |
| 04 | **Pass** with `Offline rules`, `Proof rejected`, `Held $5,000`, a disabled release control, and $4,000 still released | — | 48.7 | [Run](https://test-manager.lambdatest.com/projects/01M79MD0W5S8Y89MBQ81NBW302/test-cases/01M87WCPZZY4RTBMJHKEYQA4KX/dashboard/share/US_TLRW4JZ9I0MVP5954WR4A9XG5S6A1CVXJF7T5Q5T0IU4464DUAWZHUROWPO2Z60Z?type=summary&agentView=true&fqdn=summary-page) |

The account balance went from 8,655.44 to 8,403.10 credits. The run reports accounted for 211.6 of the 252.3 credits used. Flow 03 reused the active job left by an earlier flow, as the flow allows.

**Flow 01 stopped at a generated checkpoint.** Every explicit assertion passed. Kane interpreted the closing sentence, “Fail the test if any of these texts are missing,” as a checkpoint with an empty text list. It stopped with `assertion_error.step_not_achievable` and classified the result as `automation_bug` / `config_issue`.

The runner wrote `kane/out/FAILURES.md`. Codex CLI ran via `codex exec` (0.171.0, `gpt-6.2-astra`, high reasoning) and used the file and the hand-off prompt to diagnose the failure without starting a Kane run. [Hand-off prompt](../kane/AGENT_LOOP.md)

> Kane passed every explicit assertion, including the release header after card issuance. Step 14 failed on the trailing "any of these texts" instruction because Kane had no list for that checkpoint. I'll remove just that sentence.

Codex removed that closing sentence from flow 01 and kept every explicit assertion. All 122 Vitest tests and `tsc --noEmit` passed in both Codex's verification and an independent run. Flow 01 then passed in 281 seconds with a fresh database and browser profile. [Fix `db51d20`](https://github.com/Xuefeng-Zhu/clause-hybrid/commit/db51d20)

Flows 02 and 04 also ended with catch-all sentences during this run. Flow 02 now lists its checks directly and opens **Sandbox → Custom authorization**. That edit landed on Nov 26, after Run 4, and has not been re-run with Kane. Flow 04 still ends with its catch-all sentence, as it did when it passed Run 4.

## How the fixes were made

Hark used Kane's results and the browser state to fix the explanation and rejected-proof wording. `tsc` and all 75 Vitest tests passed, then Kane reran flows 02 and 04. Antigravity (Gemini) built the earlier Phase 2 hybrid-inference wrappers.

Commit `28a99d5` added the runner and `FAILURES.md` hand-off after that fix. The Nov 24 run was the first one documented here that used the generated hand-off.

| Step | Time (PST) | What happened |
|---|---|---|
| Failing step | Nov 15, 22:27–23:01 | Explain opens an unconnected chat and the flow 02 runner crashes while waiting |
| What the agent got | 23:03 | Kane's per-flow results, the exact UI text from Kane's browser, and the two findings |
| Fix | 23:28 | `22daf67` adds inline Explain, a validator, revised proof copy, and four tests. All 75 tests pass. |
| Passing rerun | Nov 16, 00:19–00:33 | Kane flows 02 and 04 pass on a local build of `22daf67` |
