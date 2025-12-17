# Knowledge Sync Service

Syncs company knowledge from **Notion** and **Slack** into an **OpenAI Vector Store** for RAG-based chat.

## Features

- **Notion Sync**: Fetches all accessible pages (excludes database rows), extracts content from blocks, uploads to OpenAI Vector Store
- **Slack Sync**: Fetches meaningful messages from public channels (≥50 chars, no bots), includes thread replies
- **Incremental Updates**: Uses Firestore to track sync state and content hashes to avoid reprocessing
- **Parallel Processing**: 10x concurrent uploads to OpenAI, 3x concurrent Notion fetches
- **Scheduled Runs**: Separate schedulers for Notion and Slack (daily)
- **Manual Triggers**: HTTP endpoints for on-demand syncing

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLOUD SCHEDULERS                             │
│   notion-sync-scheduler (daily at 00:00 UTC)                    │
│   slack-sync-scheduler  (daily at 00:30 UTC)                    │
└─────────────────────┬───────────────────────────────────────────┘
                      │ HTTP triggers
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│  CLOUD FUNCTIONS                                                │
│  ┌─────────────────┐    ┌─────────────────┐                     │
│  │  syncNotion     │    │   syncSlack     │                     │
│  │  - Search API   │    │   - List chans  │                     │
│  │  - Get blocks   │    │   - Get history │                     │
│  │  - Extract text │    │   - Get threads │                     │
│  └────────┬────────┘    └────────┬────────┘                     │
│           └──────────┬───────────┘                              │
│                      ▼                                          │
│           ┌─────────────────────┐                               │
│           │  Vector Store Proc  │                               │
│           │  - Parallel uploads │                               │
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
echo -n "vs_6942f90db9f08191b40a572b42047972" | gcloud secrets create OPENAI_VECTOR_STORE_ID --data-file=-
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

### Deploy All Functions (Parallel)

```bash
./scripts/deploy.sh
```

### Create Cloud Schedulers

```bash
# Notion sync - daily at midnight UTC
gcloud scheduler jobs create http notion-sync-scheduler \
  --schedule="0 0 * * *" \
  --uri="https://us-central1-slack-agent-hub.cloudfunctions.net/syncNotion" \
  --http-method=POST --location=us-central1 --project=slack-agent-hub

# Slack sync - daily at 00:30 UTC
gcloud scheduler jobs create http slack-sync-scheduler \
  --schedule="30 0 * * *" \
  --uri="https://us-central1-slack-agent-hub.cloudfunctions.net/syncSlack" \
  --http-method=POST --location=us-central1 --project=slack-agent-hub
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/syncNotion` | POST | Sync Notion pages |
| `/syncSlack` | POST | Sync Slack messages |
| `/getSyncStatus` | GET | Get current sync status |

## Local Development

### Run Locally with Functions Framework

```bash
# Create .env file with required variables
OPENAI_API_KEY=your-key
OPENAI_VECTOR_STORE_ID=vs_6942f90db9f08191b40a572b42047972
NOTION_API_KEY=ntn_xxx
SLACK_BOT_TOKEN=xoxb-xxx

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

## Content Filtering

### Notion Pages

Only syncs actual pages, not database rows:
- **Included**: `workspace` (top-level), `page_id` (nested), `block_id` (inline) parents
- **Excluded**: `database_id` parents (task trackers, credentials, automated logs)

### Slack Messages

Only syncs meaningful human messages:
- **Included**: Messages ≥50 chars from public channels, thread replies
- **Excluded**: Bot messages, system messages, short messages

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

View logs:
```bash
gcloud functions logs read syncNotion --project=slack-agent-hub
gcloud functions logs read syncSlack --project=slack-agent-hub
```

Check sync status:
```bash
curl https://us-central1-slack-agent-hub.cloudfunctions.net/getSyncStatus
```

## Rate Limits

- **Notion**: 3 requests/second - fetches run with 3x concurrency
- **Slack**: Tier-based - uses conservative 1 req/500ms
- **OpenAI**: 10x concurrent uploads with retry logic

## Consumer

The **MetricDashboard** repo queries this vector store using:
- OpenAI Assistants API with `file_search` tool
- Vector Store ID: `vs_6942f90db9f08191b40a572b42047972`
- Expects source metadata format: `[SOURCE:type|URL:url|TITLE:title]`
