#!/usr/bin/env bash
# Deploy the demo page to Google Cloud Run, built from this repository's Dockerfile.
#
#   PROJECT=<gcp-project> REGION=europe-west1 bash deploy/cloudrun.sh
#
# The service reads WORLD_JSON_B64 from the Secret Manager secret world-json-b64: the base64 of
# web/.data/world-testnet.json, the throwaway testnet demo accounts written by `npm run seed -- testnet`.
#   base64 -w0 web/.data/world-testnet.json | gcloud secrets create world-json-b64 --data-file=- --project="$PROJECT"
# One instance at most: the server runs one chain job at a time, and the demo accounts' nonces must not race.
# CPU stays allocated between requests because a chain job keeps running after its request returns.
set -euo pipefail
PROJECT="${PROJECT:?set PROJECT to the Google Cloud project}"
REGION="${REGION:-europe-west1}"

gcloud run deploy lockstep --project="$PROJECT" --region="$REGION" --source=. \
  --allow-unauthenticated --no-cpu-throttling --min-instances=0 --max-instances=1 \
  --cpu=1 --memory=512Mi --concurrency=80 --timeout=300 \
  --set-env-vars=NETWORK=testnet --set-secrets=WORLD_JSON_B64=world-json-b64:latest
