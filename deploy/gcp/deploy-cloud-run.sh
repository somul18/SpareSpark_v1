#!/usr/bin/env bash
# Deploy SpareSpark to Google Cloud Run from source (Cloud Build builds the Dockerfile).
#
# Usage, from the repository root, after `gcloud auth login`:
#   PROJECT=my-project ./deploy/gcp/deploy-cloud-run.sh
#
# Optional settings (environment variables):
#   PROJECT          Google Cloud project id (default: gcloud's current project)
#   REGION           Cloud Run region (default: us-central1)
#   SERVICE          Cloud Run service name (default: sparespark)
#   ALWAYS_ON=1      keep one instance running all the time (demo data survives idle periods; costs more)
#   PUBLIC=1         do not require an API key (anyone with the URL can use the console and API)
#   SPARESPARK_API_KEY   key the console asks for once per browser (default: a random key, printed at the end)
#   ANTHROPIC_API_KEY    optional: enables Claude-written explanations
#
# Storage: SQLite lives on the instance's in-memory disk. The week of history is re-seeded
# automatically whenever a new instance starts, so a restart behaves like "Reset Demo".
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-sparespark}"
if [[ -z "${PROJECT}" ]]; then
  echo "Set PROJECT=<your Google Cloud project id> (see: gcloud projects list)" >&2
  exit 1
fi

cd "$(dirname "$0")/../.."

echo "==> Enabling Cloud Run, Cloud Build and Artifact Registry in ${PROJECT}"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project "${PROJECT}"

# Source deploys build with the project's default compute service account. Newer projects no longer
# give it Editor, so the build fails with "storage.objects.get access ... denied" on the uploaded
# source. Cloud Run Builder is the role Google recommends for it (source bucket, Artifact Registry, logs).
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format 'value(projectNumber)')"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
echo "==> Granting Cloud Run Builder to the build service account ${BUILD_SA}"
if ! gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member "serviceAccount:${BUILD_SA}" \
    --role roles/run.builder \
    --condition None \
    --quiet >/dev/null; then
  echo "WARNING: could not grant roles/run.builder to ${BUILD_SA}." >&2
  echo "         If the build fails with a storage.objects.get error, ask a project owner to grant it." >&2
fi

ENV_VARS="SPARESPARK_DB=/data/sparespark.db,SPARESPARK_DEMO=on"
if [[ "${PUBLIC:-0}" != "1" ]]; then
  SPARESPARK_API_KEY="${SPARESPARK_API_KEY:-$(openssl rand -hex 16)}"
  ENV_VARS="${ENV_VARS},SPARESPARK_API_KEY=${SPARESPARK_API_KEY}"
fi
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  ENV_VARS="${ENV_VARS},ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
fi

MIN_INSTANCES=0
if [[ "${ALWAYS_ON:-0}" == "1" ]]; then MIN_INSTANCES=1; fi

echo "==> Building and deploying ${SERVICE} to ${REGION}"
# One instance only: SQLite and the in-process workflow timers must not be split across instances.
# --no-cpu-throttling keeps the agents' background steps running between requests.
gcloud run deploy "${SERVICE}" \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --source . \
  --allow-unauthenticated \
  --min-instances "${MIN_INSTANCES}" \
  --max-instances 1 \
  --no-cpu-throttling \
  --cpu 1 \
  --memory 512Mi \
  --timeout 300 \
  --set-env-vars "${ENV_VARS}" \
  --quiet

URL="$(gcloud run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" --format 'value(status.url)')"
echo
echo "SpareSpark is live: ${URL}"
if [[ "${PUBLIC:-0}" != "1" ]]; then
  echo "API key (the console asks for it once per browser): ${SPARESPARK_API_KEY}"
fi
echo "ServiceNow plugin: set sparespark.base_url=${URL} and sparespark.api_key to the key above."
