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

# Stop a running sync (graceful)
curl -X POST https://us-central1-slack-agent-hub.cloudfunctions.net/stopNotionSync
curl -X POST https://us-central1-slack-agent-hub.cloudfunctions.net/stopSlackSync

# Reset sync state (if stuck)
curl -X POST https://us-central1-slack-agent-hub.cloudfunctions.net/resetNotionSync
curl -X POST https://us-central1-slack-agent-hub.cloudfunctions.net/resetSlackSync

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
│   ├── notion.sync.ts              # Notion sync (streaming, resumable)
│   └── slack.sync.ts               # Slack sync (3-phase)
├── processors/
│   └── vectorStore.processor.ts    # OpenAI uploads (single + batch)
└── services/
    └── firestore.service.ts        # State tracking, checkpoints, change detection
```

## Notion Sync (Streaming Architecture)

The Notion sync uses a **streaming, resumable architecture** to handle large workspaces without OOM issues:

### Flow

```
1. INITIALIZE
   └─► Check if resuming from previous run (has cursor?)
   └─► If yes: resume from cursor
   └─► If no: start fresh, record syncStartTime

2. LOOP: Process 20 pages at a time
   └─► Fetch chunk from Notion API (sorted by last_edited_time DESC)
   └─► For each page:
       • NEW? → fetch content, upload to OpenAI, create Firestore doc
       • UPDATED? → fetch content, delete old file, upload new, update doc
       • UNCHANGED? → just mark lastSeenAt
   └─► Save checkpoint (cursor + stats) → safe to kill after this
   └─► Check kill switch → if stopRequested, exit gracefully
   └─► Check timeout → if near 55 min, exit gracefully

3. DELETE STALE
   └─► Query docs where lastSeenAt < syncStartTime
   └─► These are pages deleted from Notion → delete from OpenAI + Firestore

4. COMPLETE
   └─► Clear cursor, update status to 'completed'
```

### Key Features

- **Streaming**: Never holds all pages in memory. Processes 20 pages at a time.
- **Resumable**: Saves cursor after each chunk. Can resume from any point.
- **Killable**: Check `stopRequested` flag after each chunk (~30s max to stop).
- **Timeout-aware**: Exits gracefully at 55 min, resumes next run.
- **Delete detection**: Uses `lastSeenAt` timestamp on each document.

### Memory Usage

| Component | Memory |
|-----------|--------|
| Current chunk (20 pages metadata) | ~50KB |
| Content for changed pages (~5) | ~500KB |
| **Total** | < 1MB |

### Control Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /syncNotion` | Start or resume sync |
| `POST /stopNotionSync` | Set stop flag (graceful stop in ~30s) |
| `POST /resetNotionSync` | Clear all state, start fresh |
| `GET /getSyncStatus` | View current progress |

## Slack Sync (Streaming Architecture)

The Slack sync uses the same **streaming, resumable architecture** as Notion:

### Flow

```
1. INITIALIZE
   └─► Check if resuming (has currentChannelIndex/Cursor?)
   └─► Get list of all public channels
   └─► If resuming: skip to saved channel/cursor
   └─► If fresh: record syncStartTime

2. LOOP: Process channels sequentially
   └─► For each channel, fetch messages (paginated, 100 at a time)
   └─► For each message:
       • NEW? → fetch user, replies, upload to OpenAI, create doc
       • UPDATED? (edited or new replies) → delete old file, re-upload
       • UNCHANGED? → just mark lastSeenAt
   └─► Save checkpoint (channelIndex + cursor + stats)
   └─► Check kill switch / timeout

3. DELETE STALE
   └─► Query docs where lastSeenAt < syncStartTime
   └─► Delete from OpenAI + Firestore

4. COMPLETE
```

### Change Detection
- **New messages**: Not in Firestore
- **Edited messages**: `editedTs` changed
- **Thread updates**: `replyCount` increased

### Control Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /syncSlack` | Start or resume sync |
| `POST /stopSlackSync` | Set stop flag (graceful stop) |
| `POST /resetSlackSync` | Clear all state, start fresh |
| `GET /getSyncStatus` | View current progress |

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

### Document State Tracking
Each `KnowledgeDocument` tracks its own state:
- `lastSeenAt`: When it was last confirmed to exist in the source
- `contentHash`: For detecting content changes
- `vectorStoreFileId`: OpenAI file ID

### Incremental Sync
- **Notion**: Uses `lastEditedTime` comparison + content hash.
- **Slack**: Checks if message exists in Firestore.

## Firestore Collections

### `knowledge_sync_state`
Tracks sync progress per source:
```typescript
{
  status: 'idle' | 'running' | 'completed' | 'failed',
  lastSyncTimestamp: string,
  totalDocuments: number,
  cursor?: string,           // For resuming Notion sync
  syncStartTime?: string,    // For delete detection
  stopRequested?: boolean,   // Kill switch
  stats?: { processed, added, updated, unchanged, deleted, errored }
}
```

### `knowledge_documents`
Each synced document:
```typescript
{
  sourceType: 'notion' | 'slack',
  sourceId: string,
  vectorStoreFileId: string,
  title: string,
  url: string,
  lastModified: string,
  contentHash: string,
  lastSeenAt: string,        // For delete detection
  createdAt: string,
  updatedAt: string
}
```

## Cloud Functions

| Function | Purpose | Timeout |
|----------|---------|---------|
| `syncNotion` | Stream sync Notion pages | 60 min |
| `syncSlack` | Stream sync Slack messages | 60 min |
| `getSyncStatus` | Return current state | 60s |
| `stopNotionSync` | Request graceful stop | 60s |
| `resetNotionSync` | Reset sync state | 60s |
| `stopSlackSync` | Request graceful stop | 60s |
| `resetSlackSync` | Reset sync state | 60s |

## Deployment

```bash
./scripts/deploy.sh
```

## Environment Variables

Required (stored in GCP Secret Manager):
- `OPENAI_API_KEY`
- `OPENAI_VECTOR_STORE_ID`
- `NOTION_API_KEY`
- `SLACK_BOT_TOKEN`

For local dev, create `.env` file (already in .gitignore).

## Rate Limits

- **Notion**: 3 requests/second - smart rate limiter (only delays when needed)
- **Slack**: Tier 3 (50 req/min) - uses 1 req/1.2s rate limiter
- **OpenAI**: Retry with exponential backoff
