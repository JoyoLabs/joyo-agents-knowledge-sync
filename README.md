# Knowledge Sync Service

Syncs company knowledge from **Notion** and **Slack** into an **OpenAI Vector Store** for RAG-based chat.

## Features

- **Notion Sync**: Fetches all accessible pages, extracts content from blocks, uploads to OpenAI Vector Store
- **Slack Sync**: Fetches messages from all public channels, includes thread replies, uploads to OpenAI Vector Store
- **Incremental Updates**: Uses Firestore to track sync state and content hashes to avoid reprocessing
- **Scheduled Runs**: Runs every 6 hours via Cloud Scheduler
- **Manual Triggers**: HTTP endpoints for on-demand syncing

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLOUD SCHEDULER                              │
│                    (every 6 hours)                              │
└─────────────────────┬───────────────────────────────────────────┘
                      │ HTTP trigger
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│              CLOUD FUNCTION: syncKnowledgeBase                  │
│  ┌─────────────────┐    ┌─────────────────┐                     │
│  │  Notion Sync    │    │   Slack Sync    │                     │
│  │  - Search API   │    │   - List chans  │                     │
│  │  - Get blocks   │    │   - Get history │                     │
│  │  - Extract text │    │   - Get threads │                     │
│  └────────┬────────┘    └────────┬────────┘                     │
│           └──────────┬───────────┘                              │
│                      ▼                                          │
│           ┌─────────────────────┐                               │
│           │  Vector Store Mgr   │                               │
│           │  - Upload to OpenAI │                               │
│           │  - Track in Firestore│                              │
│           └─────────────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
```

## Prerequisites

- Node.js 20+
- GCP Project: `slack-agent-hub`
- Required GCP APIs enabled:
  - Cloud Functions API
  - Cloud Scheduler API
  - Cloud Firestore API
  - Secret Manager API

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Secrets in GCP Secret Manager

```bash
# Set your project
gcloud config set project slack-agent-hub

# Create secrets
echo -n "your-openai-api-key" | gcloud secrets create OPENAI_API_KEY --data-file=-
echo -n "vs_6941838e1f288191b75dbd9fd58df80a" | gcloud secrets create OPENAI_VECTOR_STORE_ID --data-file=-
echo -n "your-notion-api-key" | gcloud secrets create NOTION_API_KEY --data-file=-
echo -n "your-slack-bot-token" | gcloud secrets create SLACK_BOT_TOKEN --data-file=-
```

### 3. Share Notion Pages with Integration

1. Go to [notion.so/my-integrations](https://notion.so/my-integrations)
2. Find your integration
3. Share the pages/databases you want to sync with the integration

### 4. Build the Project

```bash
npm run build
```

## Deployment

### Deploy All Functions

```bash
npm run deploy:all
```

### Deploy Individual Functions

```bash
npm run deploy:syncKnowledgeBase
npm run deploy:syncNotion
npm run deploy:syncSlack
npm run deploy:getSyncStatus
```

### Create Cloud Scheduler Job

```bash
gcloud scheduler jobs create http sync-knowledge-base \
  --schedule="0 */6 * * *" \
  --uri="https://us-central1-slack-agent-hub.cloudfunctions.net/syncKnowledgeBase" \
  --http-method=POST \
  --location=us-central1 \
  --project=slack-agent-hub
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/syncKnowledgeBase` | POST | Full sync of Notion and Slack |
| `/syncNotion` | POST | Sync only Notion |
| `/syncSlack` | POST | Sync only Slack |
| `/getSyncStatus` | GET | Get current sync status |

## Local Development

### Run Locally with Functions Framework

```bash
# Set environment variables
export OPENAI_API_KEY="your-key"
export OPENAI_VECTOR_STORE_ID="vs_xxx"
export NOTION_API_KEY="ntn_xxx"
export SLACK_BOT_TOKEN="xoxb-xxx"

# Start the function
npm start
```

Then trigger with:
```bash
curl -X POST http://localhost:8080/
```

## Firestore Collections

### `knowledge_sync_state`

Tracks sync state for each source:
- `notion`: `{ lastSyncTimestamp, status, totalDocuments, lastError?, lastRunAt? }`
- `slack`: `{ lastSyncTimestamp, status, totalDocuments, lastError?, lastRunAt? }`

### `knowledge_documents`

Tracks individual synced documents:
- Document ID: `{source}_{sourceId}` (e.g., `notion_abc123`, `slack_C123_1702684800`)
- Fields: `sourceType, sourceId, vectorStoreFileId, title, url, lastModified, contentHash, createdAt, updatedAt`

## Content Format

Documents are uploaded with metadata headers for source tracking:

**Notion:**
```
[SOURCE:notion|URL:https://notion.so/page-xyz|TITLE:Engineering Onboarding Guide]

{actual content here...}
```

**Slack:**
```
[SOURCE:slack|URL:https://slack.com/archives/C123/p1702684800|TITLE:Slack message in #engineering]

Author: John Doe
Channel: #engineering
Time: 2024-12-15T10:30:00Z

{message content}

--- Thread Replies ---
Jane: {reply}
```

## Monitoring

The service logs:
- Sync started/completed
- Documents added/updated/skipped/errored (with counts)
- API rate limit warnings
- Vector store file IDs created

View logs in Google Cloud Console:
```bash
gcloud functions logs read syncKnowledgeBase --project=slack-agent-hub
```

## Troubleshooting

### Rate Limits

- **Notion**: 3 requests/second - handled with rate limiter
- **Slack**: Tier-based - handled with rate limiter
- **OpenAI**: Handled with retry logic

### Common Issues

1. **Missing secrets**: Ensure all secrets are created in Secret Manager
2. **Notion access**: Make sure pages are shared with the integration
3. **Slack scopes**: Bot needs `channels:read`, `channels:history`, `users:read`

## Consumer

The **MetricDashboard** repo queries this vector store using:
- OpenAI Assistants API with `file_search` tool
- Vector Store ID: `vs_6941838e1f288191b75dbd9fd58df80a`
- Expects source metadata format: `[SOURCE:type|URL:url|TITLE:title]`



