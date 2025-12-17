#!/bin/bash
set -e

PROJECT="slack-agent-hub"
REGION="us-central1"
RUNTIME="nodejs20"
MEMORY="512MB"
TIMEOUT="3600s"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Building TypeScript...${NC}"
npm run build

echo -e "${YELLOW}Deploying Cloud Functions...${NC}"

# Deploy all functions in parallel
gcloud functions deploy syncNotion \
  --gen2 \
  --runtime=$RUNTIME \
  --region=$REGION \
  --source=. \
  --entry-point=syncNotion \
  --trigger-http \
  --allow-unauthenticated \
  --memory=$MEMORY \
  --timeout=$TIMEOUT \
  --project=$PROJECT \
  --set-secrets="OPENAI_API_KEY=OPENAI_API_KEY:latest,OPENAI_VECTOR_STORE_ID=OPENAI_VECTOR_STORE_ID:latest,NOTION_API_KEY=NOTION_API_KEY:latest,SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest" \
  --quiet &

gcloud functions deploy syncSlack \
  --gen2 \
  --runtime=$RUNTIME \
  --region=$REGION \
  --source=. \
  --entry-point=syncSlack \
  --trigger-http \
  --allow-unauthenticated \
  --memory=$MEMORY \
  --timeout=$TIMEOUT \
  --project=$PROJECT \
  --set-secrets="OPENAI_API_KEY=OPENAI_API_KEY:latest,OPENAI_VECTOR_STORE_ID=OPENAI_VECTOR_STORE_ID:latest,NOTION_API_KEY=NOTION_API_KEY:latest,SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest" \
  --quiet &

gcloud functions deploy getSyncStatus \
  --gen2 \
  --runtime=$RUNTIME \
  --region=$REGION \
  --source=. \
  --entry-point=getSyncStatus \
  --trigger-http \
  --allow-unauthenticated \
  --memory=256MB \
  --timeout=60s \
  --project=$PROJECT \
  --set-secrets="OPENAI_API_KEY=OPENAI_API_KEY:latest,OPENAI_VECTOR_STORE_ID=OPENAI_VECTOR_STORE_ID:latest,NOTION_API_KEY=NOTION_API_KEY:latest,SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest" \
  --quiet &

# Wait for all deployments to complete
wait

echo -e "${GREEN}All functions deployed successfully!${NC}"
echo ""
echo "Endpoints:"
echo "  https://$REGION-$PROJECT.cloudfunctions.net/syncNotion"
echo "  https://$REGION-$PROJECT.cloudfunctions.net/syncSlack"
echo "  https://$REGION-$PROJECT.cloudfunctions.net/getSyncStatus"
