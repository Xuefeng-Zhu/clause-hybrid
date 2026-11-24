# Agent loop prompt (Kane → coding agent → Kane)

`kane/run-flows.sh` writes `kane/out/FAILURES.md` (each failing flow with Kane's last steps) and exits non-zero.
Give that file and the prompt below to any coding agent (Hark, Antigravity, Claude Code, Codex…).

For the one real fix so far (`22daf67`, the empty Explain chat), the agent was Hark, working from Kane's results
on Nov 15 before this script existed; there was no `FAILURES.md` that night. See docs/KANE.md, "How the fixes were made".

> Read kane/out/FAILURES.md. Each section is a Kane CLI flow that failed in a real browser, with Kane's last steps.
> For each failure: find the UI or logic that caused it, fix it with the smallest change, keep money controls
> deterministic (AI never approves or releases funds), add or update a Vitest test, run `npx tsc --noEmit`
> and `npx vitest run`, then re-run only the failed flows with `kane/run-flows.sh <ids>`.
> Stop when every flow passes or after two attempts per flow, and summarize what changed.
