#!/usr/bin/env bash
# Build + deploy the expiring Kane preview.
#   deploy/deploy-preview.sh build    -> Cloud Build image (async; prints build id)
#   deploy/deploy-preview.sh run      -> deploy image to Cloud Run
#   deploy/deploy-preview.sh channel  -> Firebase Hosting preview channel "kane" (7d)
# Reads client VITE_* values from .env.local at deploy time; VITE_APPCHECK_DEBUG_TOKEN is never sent.
set -euo pipefail
PROJECT=${PROJECT:-fbailogic26vrt-3071}
REGION=${REGION:-us-west1}
SERVICE=${SERVICE:-clause-hybrid-preview}
REPO=${REPO:-clause-preview}
IMAGE=${IMAGE:-$REGION-docker.pkg.dev/$PROJECT/$REPO/clause-hybrid:$(git rev-parse --short HEAD)}
cd "$(dirname "$0")/.."

envval() { grep -E "^$1=" .env.local | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

case "${1:-}" in
  build)
    gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 ||
      gcloud artifacts repositories create "$REPO" --repository-format=docker --location "$REGION" --project "$PROJECT"
    SUBS="_IMAGE=$IMAGE"
    for k in VITE_FIREBASE_API_KEY VITE_FIREBASE_AUTH_DOMAIN VITE_FIREBASE_PROJECT_ID VITE_FIREBASE_STORAGE_BUCKET \
             VITE_FIREBASE_MESSAGING_SENDER_ID VITE_FIREBASE_APP_ID VITE_RECAPTCHA_ENTERPRISE_SITE_KEY VITE_CLOUD_MODEL; do
      SUBS="$SUBS,_$k=$(envval $k)"
    done
    gcloud builds submit . --async --project "$PROJECT" \
      --config deploy/cloudbuild.preview.yaml --substitutions "$SUBS" --format='value(id)'
    ;;
  run)
    gcloud run deploy "$SERVICE" --image "$IMAGE" --region "$REGION" --project "$PROJECT" \
      --allow-unauthenticated --min-instances 0 --max-instances 2 --cpu 1 --memory 2Gi \
      --concurrency 40 --timeout 300 --port 8080 \
      --set-env-vars "AUTH_DISABLED=true,NETLIFY_LOCAL=true,BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-$(openssl rand -hex 32)}"
    ;;
  channel)
    npx -y firebase-tools@latest hosting:channel:deploy kane --expires 7d --project "$PROJECT"
    ;;
  *) echo "usage: $0 build|run|channel" >&2; exit 2;;
esac
