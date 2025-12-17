# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Knowledge Sync Service that syncs company knowledge from Notion and Slack into an OpenAI Vector Store for RAG-based chat. Deployed as Google Cloud Functions (Gen 2) to GCP project `slack-agent-hub`.

## Commands

```bash
# Build
npm run build

# Run locally (requires .env file or env vars)
npm start

# Watch mode
npm run dev

# Deploy all functions (parallel, ~2 min)
./scripts/deploy.sh

# View logs
gcloud functions logs read syncNotion --project=slack-agent-hub
gcloud functions logs read syncSlack --project=slack-agent-hub

# Manual sync triggers
curl -X POST https://us-central1-slack-agent-hub.cloudfunctions.net/syncNotion
curl -X POST https://us-central1-slack-agent-hub.cloudfunctions.net/syncSlack

# Check sync status
curl https://us-central1-slack-agent-hub.cloudfunctions.net/getSyncStatus

# Cleanup (reset Firestore, optionally delete vector store)
npx ts-node scripts/cleanup.ts
npx ts-node scripts/cleanup.ts --delete-store
```

## Architecture

```
src/
├── index.ts                        # Cloud Function HTTP entry points
├── config.ts                       # Environment variable loading
├── types/index.ts                  # All TypeScript interfaces
├── sync/
│   ├── notion.sync.ts              # Notion sync (4-phase)
│   └── slack.sync.ts               # Slack sync (3-phase)
├── processors/
│   └── vectorStore.processor.ts    # Parallel async OpenAI uploads
└── services/
    └── firestore.service.ts        # State tracking, change detection
```

## Sync Flow

### Notion Sync (4 phases)

1. **Discover** - Fetch all page metadata via Search API (~30s for 2000+ results)
2. **Diff** - Compare with Firestore to find adds/updates/deletes
3. **Fetch Content** - Get block content for changed pages (3x concurrent)
4. **Process** - Upload to OpenAI Vector Store (10x concurrent, non-blocking)

**Important:** Only syncs actual pages (`workspace`, `page_id`, `block_id` parents). Excludes `database_id` parents (database rows) which may contain sensitive data like credentials or automated logs.

### Slack Sync (3 phases)

1. **Discover** - Fetch new messages since last sync
2. **Build Operations** - Create upload queue for new messages
3. **Process** - Upload to OpenAI Vector Store (10x concurrent)

Messages are immutable - no update/delete detection needed.

## Key Design Decisions

### Page Filtering (Notion)
The Notion Search API returns database rows as "pages". We filter to include:
- `workspace` parent: Top-level pages
- `page_id` parent: Nested pages under other pages
- `block_id` parent: Inline pages embedded in blocks

Excluded:
- `database_id` parent: Database rows (task trackers, credentials, automated logs)

### Message Filtering (Slack)
Only syncs meaningful human messages. Included:
- Messages from public channels
- Messages ≥50 characters
- Thread replies (bundled with parent message)

Excluded:
- Bot messages (GitHub, Linear, purchase notifications)
- System messages (joins, leaves, channel updates)
- Short messages <50 chars (reactions, acknowledgments)

### Async Vector Store Uploads
OpenAI file uploads don't block on processing. Files are uploaded in parallel (10 concurrent) without waiting for vector store indexing to complete.

### Incremental Sync
- **Notion**: Uses content hash to detect changes. Deletes old file, uploads new on change.
- **Slack**: Checks if message exists in Firestore. Messages are immutable.

## Firestore Collections

- `knowledge_sync_state`: Tracks last sync timestamp per source (`notion`, `slack`)
- `knowledge_documents`: Tracks each synced document with content hash and vector store file ID

## Cloud Functions

| Function | Purpose | Scheduler |
|----------|---------|-----------|
| `syncNotion` | Sync all Notion pages | `notion-sync-scheduler` (daily at 00:00 UTC) |
| `syncSlack` | Sync all Slack messages | `slack-sync-scheduler` (daily at 00:30 UTC) |
| `getSyncStatus` | Returns current sync state | Manual only |

## Deployment

Use the deploy script for parallel deployment (~2 min total):

```bash
./scripts/deploy.sh
```

To set up schedulers (one-time):

```bash
# Notion sync - daily at midnight UTC
gcloud scheduler jobs create http notion-sync-scheduler \
  --schedule="0 0 * * *" \
  --uri="https://us-central1-slack-agent-hub.cloudfunctions.net/syncNotion" \
  --http-method=POST --location=us-central1 --project=slack-agent-hub

# Slack sync - daily at 00:30 UTC (offset from Notion)
gcloud scheduler jobs create http slack-sync-scheduler \
  --schedule="30 0 * * *" \
  --uri="https://us-central1-slack-agent-hub.cloudfunctions.net/syncSlack" \
  --http-method=POST --location=us-central1 --project=slack-agent-hub
```

To manage schedulers:

```bash
# Pause/resume
gcloud scheduler jobs pause notion-sync-scheduler --location=us-central1 --project=slack-agent-hub
gcloud scheduler jobs resume notion-sync-scheduler --location=us-central1 --project=slack-agent-hub

# List all
gcloud scheduler jobs list --location=us-central1 --project=slack-agent-hub
```

## Environment Variables

Required (stored in GCP Secret Manager):
- `OPENAI_API_KEY`
- `OPENAI_VECTOR_STORE_ID`
- `NOTION_API_KEY`
- `SLACK_BOT_TOKEN`

For local dev, create `.env` file (already in .gitignore).

## Rate Limits

- **Notion**: 3 requests/second - fetches run with 3x concurrency
- **Slack**: Tier-based - uses conservative 1 req/500ms
- **OpenAI**: 10x concurrent uploads, retry with exponential backoff
