#!/bin/bash
set -e

PROJECT="slack-agent-hub"
REGION="us-central1"
RUNTIME="nodejs20"
MEMORY="4Gi"
TIMEOUT="3600s"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Building TypeScript...${NC}"
npm run build

echo -e "${YELLOW}Deploying Cloud Functions...${NC}"

# Deploy sync functions (called by Cloud Scheduler)
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
  --max-instances=1 \
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
  --max-instances=1 \
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

gcloud functions deploy stopNotionSync \
  --gen2 \
  --runtime=$RUNTIME \
  --region=$REGION \
  --source=. \
  --entry-point=stopNotionSync \
  --trigger-http \
  --allow-unauthenticated \
  --memory=256MB \
  --timeout=60s \
  --project=$PROJECT \
  --set-secrets="OPENAI_API_KEY=OPENAI_API_KEY:latest,OPENAI_VECTOR_STORE_ID=OPENAI_VECTOR_STORE_ID:latest,NOTION_API_KEY=NOTION_API_KEY:latest,SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest" \
  --quiet &

gcloud functions deploy resetNotionSync \
  --gen2 \
  --runtime=$RUNTIME \
  --region=$REGION \
  --source=. \
  --entry-point=resetNotionSync \
  --trigger-http \
  --allow-unauthenticated \
  --memory=256MB \
  --timeout=60s \
  --project=$PROJECT \
  --set-secrets="OPENAI_API_KEY=OPENAI_API_KEY:latest,OPENAI_VECTOR_STORE_ID=OPENAI_VECTOR_STORE_ID:latest,NOTION_API_KEY=NOTION_API_KEY:latest,SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest" \
  --quiet &

gcloud functions deploy stopSlackSync \
  --gen2 \
  --runtime=$RUNTIME \
  --region=$REGION \
  --source=. \
  --entry-point=stopSlackSync \
  --trigger-http \
  --allow-unauthenticated \
  --memory=256MB \
  --timeout=60s \
  --project=$PROJECT \
  --set-secrets="OPENAI_API_KEY=OPENAI_API_KEY:latest,OPENAI_VECTOR_STORE_ID=OPENAI_VECTOR_STORE_ID:latest,NOTION_API_KEY=NOTION_API_KEY:latest,SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest" \
  --quiet &

gcloud functions deploy resetSlackSync \
  --gen2 \
  --runtime=$RUNTIME \
  --region=$REGION \
  --source=. \
  --entry-point=resetSlackSync \
  --trigger-http \
  --allow-unauthenticated \
  --memory=256MB \
  --timeout=60s \
  --project=$PROJECT \
  --set-secrets="OPENAI_API_KEY=OPENAI_API_KEY:latest,OPENAI_VECTOR_STORE_ID=OPENAI_VECTOR_STORE_ID:latest,NOTION_API_KEY=NOTION_API_KEY:latest,SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest" \
  --quiet &

# Wait for all deployments to complete
wait

echo -e "${YELLOW}Setting up Cloud Scheduler jobs...${NC}"

# Delete existing scheduler jobs if they exist (to update them)
gcloud scheduler jobs delete notion-sync-daily --location=$REGION --project=$PROJECT --quiet 2>/dev/null || true
gcloud scheduler jobs delete slack-sync-daily --location=$REGION --project=$PROJECT --quiet 2>/dev/null || true

# Create Cloud Scheduler jobs with HTTP targets
# Notion sync at 2:00 AM UTC daily
gcloud scheduler jobs create http notion-sync-daily \
  --location=$REGION \
  --schedule="0 2 * * *" \
  --uri="https://$REGION-$PROJECT.cloudfunctions.net/syncNotion" \
  --http-method=POST \
  --time-zone="UTC" \
  --project=$PROJECT \
  --quiet

# Slack sync at 2:30 AM UTC daily (30min offset from Notion)
gcloud scheduler jobs create http slack-sync-daily \
  --location=$REGION \
  --schedule="30 2 * * *" \
  --uri="https://$REGION-$PROJECT.cloudfunctions.net/syncSlack" \
  --http-method=POST \
  --time-zone="UTC" \
  --project=$PROJECT \
  --quiet

echo -e "${GREEN}All functions deployed successfully!${NC}"
echo ""
echo "Scheduled Functions (via Cloud Scheduler):"
echo "  syncNotion - daily at 2:00 AM UTC"
echo "  syncSlack  - daily at 2:30 AM UTC"
echo ""
echo "HTTP Endpoints:"
echo "  https://$REGION-$PROJECT.cloudfunctions.net/getSyncStatus"
echo ""
echo "Control endpoints:"
echo "  https://$REGION-$PROJECT.cloudfunctions.net/stopNotionSync"
echo "  https://$REGION-$PROJECT.cloudfunctions.net/resetNotionSync"
echo "  https://$REGION-$PROJECT.cloudfunctions.net/stopSlackSync"
echo "  https://$REGION-$PROJECT.cloudfunctions.net/resetSlackSync"
echo ""
echo "To manually trigger syncs (via Cloud Scheduler):"
echo "  gcloud scheduler jobs run notion-sync-daily --location=$REGION --project=$PROJECT"
echo "  gcloud scheduler jobs run slack-sync-daily --location=$REGION --project=$PROJECT"
