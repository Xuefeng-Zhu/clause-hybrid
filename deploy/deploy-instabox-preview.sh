#!/usr/bin/env bash
set -euo pipefail
set +x

preview_name=clause-hybrid-demo
preview_port=8080

smoke_preview() {
  node --input-type=module - "$1" <<'NODE'
const origin = new URL(process.argv[2]);
if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('Use an HTTP or HTTPS preview URL');
if (origin.username || origin.password) throw new Error('Use a preview URL without embedded credentials');

async function get(path) {
  const response = await fetch(new URL(path, origin), {
    redirect: 'manual',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response;
}

const [ping, home, jobs] = await Promise.all([
  get('/_agent-native/ping'),
  get('/home'),
  get('/_agent-native/actions/list-jobs'),
]);
if (typeof (await ping.json())?.message !== 'string') throw new Error('Invalid health response');
if (!(await home.text()).includes('<title>Clause')) throw new Error('Expected the Clause workspace at /home');
const body = await jobs.json();
const workspace = body?.result ?? body?.data ?? body;
const runtime = workspace?.runtime;
if (!Array.isArray(workspace?.jobs) || runtime?.contestMode !== true ||
    runtime.airwallexMode !== 'mock' || runtime.metalMode !== 'mock') {
  throw new Error('Expected a contest-mode jobs endpoint with both mock providers');
}
console.log(`Clause preview smoke passed at ${origin.origin}`);
NODE
}

case "${1:-}" in
  smoke)
    if [[ $# != 2 ]]; then echo "Usage: $0 smoke <preview-url>" >&2; exit 2; fi
    smoke_preview "$2"
    exit
    ;;
  deploy)
    if [[ $# != 2 ]]; then echo "Usage: $0 deploy <git-ref>" >&2; exit 2; fi
    ;;
  *)
    echo "Usage: $0 deploy <git-ref> | smoke <preview-url>" >&2
    exit 2
    ;;
esac

for tool in docker git flock node openssl; do
  if ! command -v "$tool" >/dev/null; then echo "$tool is required to deploy" >&2; exit 1; fi
done

cd "$(dirname "$0")/.."
commit=$(git rev-parse --verify --end-of-options "$2^{commit}")
image="$preview_name:$commit"
state_dir=${CLAUSE_PREVIEW_STATE_DIR:-/data/clause-preview}
web_env=${CLAUSE_WEB_ENV_FILE:-.env.local}
if [[ ! -r "$web_env" ]]; then echo "Firebase web settings are missing: $web_env" >&2; exit 1; fi

web_value() {
  local value
  value=$(awk -v prefix="$1=" 'index($0, prefix) == 1 { value = substr($0, length(prefix) + 1) }
    END { sub(/\r$/, "", value); print value }' "$web_env")
  case "$value" in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac
  printf '%s' "$value"
}

build_args=()
for key in VITE_FIREBASE_API_KEY VITE_FIREBASE_PROJECT_ID VITE_FIREBASE_APP_ID VITE_RECAPTCHA_ENTERPRISE_SITE_KEY; do
  value=$(web_value "$key")
  if [[ -z "$value" ]]; then echo "Set $key in $web_env" >&2; exit 1; fi
  build_args+=(--build-arg "$key=$value")
done
for key in VITE_FIREBASE_AUTH_DOMAIN VITE_FIREBASE_STORAGE_BUCKET VITE_FIREBASE_MESSAGING_SENDER_ID VITE_CLOUD_MODEL; do
  value=$(web_value "$key")
  if [[ -n "$value" ]]; then build_args+=(--build-arg "$key=$value"); fi
done

umask 077
mkdir -p "$state_dir"
exec 9>"$state_dir/deploy.lock"
if ! flock -n 9; then echo "A Clause preview deployment is already running" >&2; exit 1; fi
docker info >/dev/null

build_context=$(mktemp -d)
secret_tmp=
candidate_id=
previous_id=
previous_was_running=false
switch_started=false
verified=false

cleanup() {
  local status=$?
  if [[ "$verified" == false && -n "$candidate_id" ]]; then
    if ! docker rm -f "$candidate_id" >/dev/null; then
      echo "Could not remove failed candidate $candidate_id" >&2
    fi
  fi
  if [[ "$verified" == false && "$switch_started" == true && -n "$previous_id" ]]; then
    echo "Restoring the previous Clause container" >&2
    if [[ $(docker inspect --format '{{.Name}}' "$previous_id") != "/$preview_name" ]]; then
      docker rename "$previous_id" "$preview_name" || echo "Could not restore the previous container name" >&2
    fi
    if [[ "$previous_was_running" == true ]]; then
      docker start "$previous_id" >/dev/null || echo "Could not restart the previous container" >&2
    fi
  fi
  if [[ -n "$secret_tmp" ]]; then rm -f -- "$secret_tmp"; fi
  rm -rf -- "$build_context"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git archive --format=tar "$commit" | tar -xf - -C "$build_context"
docker build --label "org.opencontainers.image.revision=$commit" "${build_args[@]}" -t "$image" "$build_context"
image_id=$(docker image inspect --format '{{.Id}}' "$image")

secret_env="$state_dir/runtime.env"
if [[ ! -s "$secret_env" ]]; then
  secret_tmp=$(mktemp "$state_dir/runtime.XXXXXX")
  secret=$(openssl rand -hex 32)
  printf 'BETTER_AUTH_SECRET=%s\n' "$secret" > "$secret_tmp"
  unset secret
  mv "$secret_tmp" "$secret_env"
  secret_tmp=
fi
chmod 600 "$secret_env"

# Create the replacement while the previous image still serves traffic.
candidate_id=$(docker create --name "$preview_name-candidate-$$" --restart unless-stopped \
  --publish "$preview_port:8080" --env-file "$secret_env" \
  --env CLAUSE_CONTEST_MODE=true --env AUTH_DISABLED=true --env NETLIFY_LOCAL=true \
  --env HOST=0.0.0.0 "$image_id")
previous_id=$(docker container inspect --format '{{.Id}}' "$preview_name" 2>/dev/null || true)
if [[ -n "$previous_id" ]]; then
  previous_was_running=$(docker inspect --format '{{.State.Running}}' "$previous_id")
  switch_started=true
  if [[ "$previous_was_running" == true ]]; then docker stop "$previous_id" >/dev/null; fi
  docker rename "$previous_id" "$preview_name-previous-$$"
fi
docker rename "$candidate_id" "$preview_name"
docker start "$candidate_id" >/dev/null

for attempt in {1..15}; do
  if smoke_preview "http://127.0.0.1:$preview_port" >/dev/null 2>&1; then
    verified=true
    break
  fi
  if [[ $(docker inspect --format '{{.State.Running}}' "$candidate_id") != true ]]; then break; fi
  sleep 2
done
if [[ "$verified" == false ]]; then
  echo "Clause $commit did not pass local preview smoke checks" >&2
  exit 1
fi

if [[ -n "$previous_id" ]]; then
  docker rm "$previous_id" >/dev/null || echo "Previous container remains stopped: $previous_id" >&2
fi
echo "Clause $commit is serving locally on port $preview_port"
