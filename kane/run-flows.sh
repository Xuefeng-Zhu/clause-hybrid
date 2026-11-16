#!/usr/bin/env bash
# Closed loop: run each Kane CLI flow against the app; on failure, write kane/out/FAILURES.md
# with Kane's failing step, which the coding agent reads (see kane/AGENT_LOOP.md), fixes, and re-runs.
#   KANE_URL=http://127.0.0.1:8787/home KANE_PROOF_FILE=/path/to/non-site-photo.jpg kane/run-flows.sh [01 02 ...]
# Needs: npm i -g @testmuai/kane-cli && kane-cli login (TestMu AI account).
set -uo pipefail
cd "$(dirname "$0")"
URL=${KANE_URL:-http://127.0.0.1:8787/home}
mkdir -p out; : > out/FAILURES.md; fails=0
flows=("$@"); [ ${#flows[@]} -eq 0 ] && flows=(01 02 03 04)
for id in "${flows[@]}"; do
  f=$(ls flows/${id}-*.txt | head -1); name=$(basename "$f" .txt)
  obj=$(envsubst < "$f")
  echo "▶ $name"
  sleep 900 | kane-cli run "$obj" --url "$URL" --agent --final-validation on \
    --max-steps "${KANE_MAX_STEPS:-30}" --timeout 300 ${KANE_CDP:+--cdp-endpoint "$KANE_CDP"} \
    > "out/$name.ndjson" 2> "out/$name.err"
  code=$?
  if [ $code -eq 0 ]; then echo "  ✓ pass"; else
    fails=$((fails+1)); echo "  ✗ fail (exit $code)"
    { echo "## $name (exit $code)"; echo; echo '```'; tail -n 40 "out/$name.ndjson"; echo '```'; echo; } >> out/FAILURES.md
  fi
done
echo "$fails failing flow(s). Details: kane/out/FAILURES.md"
exit $fails
