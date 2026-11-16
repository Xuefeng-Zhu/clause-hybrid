# Agent loop prompt (Kane → coding agent → Kane)

Give this to the coding agent (Antigravity, Claude Code, Codex…) after `kane/run-flows.sh` exits non-zero:

> Read kane/out/FAILURES.md. Each section is a Kane CLI flow that failed in a real browser, with Kane's last steps.
> For each failure: find the UI or logic that caused it, fix it with the smallest change, keep money controls
> deterministic (AI never approves or releases funds), add or update a Vitest test, run `npx tsc --noEmit`
> and `npx vitest run`, then re-run only the failed flows with `kane/run-flows.sh <ids>`.
> Stop when every flow passes or after two attempts per flow, and summarize what changed.
