#!/usr/bin/env bash
# Run the Kane CLI flows in kane/flows/ against the app and collect failures for the coding agent.
#   KANE_URL=http://localhost:8080/home kane/run-flows.sh 02      # one flow (start here)
#   KANE_URL=http://localhost:8080/home kane/run-flows.sh         # flows 01-04
#   KANE_URL=http://localhost:8080/home KANE_MAX_STEPS=45 kane/run-flows.sh 06  # travel exception and CSV
# KANE_URL: the URL your dev server prints, plus /home. KANE_PROOF_FILE (flow 04): defaults to
# kane/fixtures/stock-not-job-site.jpg. On failure, kane/out/FAILURES.md gets Kane's last steps
# (see kane/AGENT_LOOP.md). Flow 05 (offline) is a manual Chrome DevTools check, not run here.
# Needs: npm i -g @testmuai/kane-cli && kane-cli login (TestMu AI account; each run spends credits).
set -uo pipefail
cd "$(dirname "$0")" || exit 2
URL=${KANE_URL:-http://localhost:8080/home}
PROOF=${KANE_PROOF_FILE:-$PWD/fixtures/stock-not-job-site.jpg}
command -v kane-cli >/dev/null || { echo "kane-cli not found: npm i -g @testmuai/kane-cli && kane-cli login" >&2; exit 2; }
mkdir -p out; : > out/FAILURES.md; fails=0

# kane-cli's runner exits early when its stdin is closed (seen with 0.10.4 under a non-interactive shell),
# so give it a stdin that stays open but never sends anything. It is a background process substitution,
# not a pipeline, so each flow's result returns as soon as kane-cli exits.
exec 3< <(exec sleep 2147483647)
KEEP_PID=$!
trap 'kill "$KEEP_PID" 2>/dev/null' EXIT

flows=("$@"); [ ${#flows[@]} -eq 0 ] && flows=(01 02 03 04)
for id in "${flows[@]}"; do
  matches=(flows/"${id}"-*.txt); f=${matches[0]}
  [ -f "$f" ] || { echo "no flow $id in kane/flows/" >&2; fails=$((fails+1)); continue; }
  [ "$id" = 05 ] && { echo "05 is a manual offline check; see kane/flows/05-offline.txt"; continue; }
  name=$(basename "$f" .txt)
  obj=$(<"$f"); obj=${obj//\$KANE_PROOF_FILE/$PROOF}
  echo "▶ $name"
  kane-cli run "$obj" --url "$URL" --agent --final-validation on \
    --max-steps "${KANE_MAX_STEPS:-30}" --timeout 300 ${KANE_CDP:+--cdp-endpoint "$KANE_CDP"} \
    <&3 > "out/$name.ndjson" 2> "out/$name.err"
  code=$?
  if [ $code -eq 0 ]; then echo "  ✓ pass"; else
    fails=$((fails+1)); echo "  ✗ fail (exit $code)"
    { echo "## $name (exit $code)"; echo; echo '```'; tail -n 40 "out/$name.ndjson"; echo '```'; echo; } >> out/FAILURES.md
  fi
done
echo "$fails failing flow(s). Details: kane/out/FAILURES.md"
exit $fails
