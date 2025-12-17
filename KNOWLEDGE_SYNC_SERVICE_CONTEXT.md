# Knowledge Sync Service - Project Context for Cursor

> **Give this document to Cursor when setting up the new project.**
> Project will be deployed to GCP Project: `slack-agent-hub`

---

## 1. Project Purpose

Build a service that syncs company knowledge from **Notion** and **Slack** into an **OpenAI Vector Store** for RAG-based chat. The MetricDashboard (separate repo) will query this vector store via OpenAI's Assistants API.

**This service is responsible for:**
- Fetching pages from Notion API
- Fetching messages from Slack API
- Chunking and uploading content to OpenAI Vector Store
- Running on a schedule (every 6 hours) with incremental updates
- Tracking sync state to avoid reprocessing unchanged content

---

## 2. Target Deployment

| Setting | Value |
|---------|-------|
| **Platform** | Google Cloud Functions (Gen 2) or Cloud Run |
| **GCP Project ID** | `slack-agent-hub` |
| **Region** | `us-central1` (recommended) |
| **Runtime** | Node.js 20 or Python 3.11 |
| **Trigger** | Cloud Scheduler (every 6 hours) + HTTP for manual triggers |

---

## 3. Required APIs & Services

Enable these in GCP Console for `slack-agent-hub`:
- Cloud Functions API
- Cloud Scheduler API
- Cloud Firestore API (for state tracking)
- Secret Manager API (for credentials)

---

## 4. Environment Variables / Secrets

Store these in **Google Secret Manager**:

```
OPENAI_API_KEY          = 
OPENAI_VECTOR_STORE_ID  = 
NOTION_API_KEY          = 
SLACK_BOT_TOKEN         = 
```

---

## 5. Architecture Overview

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
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
┌───────────┐  ┌───────────┐  ┌───────────┐
│  Notion   │  │   Slack   │  │  OpenAI   │
│   API     │  │    API    │  │  Vector   │
│           │  │           │  │  Store    │
└───────────┘  └───────────┘  └───────────┘
```

---

## 6. Data Flow

### Notion Sync Flow
1. Read `lastSyncTimestamp` from Firestore (`knowledge_sync_state/notion`)
2. Call Notion Search API, sorted by `last_edited_time` descending
3. For each page modified since last sync:
   - Fetch all blocks (page content)
   - Extract plain text from blocks
   - Calculate content hash
   - If new or changed: upload to OpenAI Vector Store
   - Save tracking record to Firestore
4. Update `lastSyncTimestamp`

### Slack Sync Flow
1. Read `lastSyncTimestamp` from Firestore (`knowledge_sync_state/slack`)
2. List all public channels
3. For each channel, fetch messages with `oldest = lastSyncTimestamp`
4. For each substantial message (>50 chars, not bot):
   - Get thread replies if any
   - Get author name and permalink
   - Upload to OpenAI Vector Store
   - Save tracking record to Firestore
5. Update `lastSyncTimestamp`

---

## 7. Firestore Collections

**Collection: `knowledge_sync_state`**
- Document `notion`: `{ lastSyncTimestamp, status, totalDocuments, lastError? }`
- Document `slack`: `{ lastSyncTimestamp, status, totalDocuments, lastError? }`

**Collection: `knowledge_documents`**
- Document ID: `{source}_{sourceId}` (e.g., `notion_abc123`, `slack_C123_1702684800`)
- Fields: `sourceType, sourceId, vectorStoreFileId, title, url, lastModified, contentHash`

---

## 8. Content Format for Vector Store

Each document uploaded to OpenAI should have metadata embedded at the top:

```
[SOURCE:notion|URL:https://notion.so/page-xyz|TITLE:Engineering Onboarding Guide]

{actual content here...}
```

```
[SOURCE:slack|URL:https://slack.com/archives/C123/p1702684800|TITLE:Slack message in #engineering]

Author: John Doe
Channel: #engineering
Time: 2024-12-15T10:30:00Z

{message content}

--- Thread Replies ---
Jane: {reply}
```

This format allows the consuming chat service to parse source citations.

---

## 9. API Reference

### Notion API (npm: @notionhq/client)

**Search for pages:**
```
POST https://api.notion.com/v1/search
{
  "filter": { "property": "object", "value": "page" },
  "sort": { "direction": "descending", "timestamp": "last_edited_time" },
  "page_size": 100
}
```

**Get page blocks:**
```
GET https://api.notion.com/v1/blocks/{page_id}/children?page_size=100
```

**Block types to extract text from:**
- paragraph, heading_1/2/3, bulleted_list_item, numbered_list_item
- to_do, toggle, quote, callout, code
- All have `rich_text` array → extract `plain_text`

### Slack API (npm: @slack/web-api)

**List channels:** `conversations.list({ types: 'public_channel', exclude_archived: true })`

**Get history:** `conversations.history({ channel, oldest: timestamp, limit: 200 })`

**Get thread:** `conversations.replies({ channel, ts: thread_ts })`

**Get user:** `users.info({ user: userId })` → `user.real_name`

**Get permalink:** `chat.getPermalink({ channel, message_ts })`

### OpenAI API (npm: openai)

**Upload file:**
```javascript
const file = await openai.files.create({
  file: new File([content], 'doc.txt', { type: 'text/plain' }),
  purpose: 'assistants'
});
```

**Add to vector store:**
```javascript
await openai.beta.vectorStores.files.create(vectorStoreId, { file_id: file.id });
```

**Wait for processing:** Poll `vectorStores.files.retrieve()` until `status !== 'in_progress'`

**Delete file:** `await openai.files.del(fileId)` (for updates)

---

## 10. Incremental Sync Logic

### Notion (content can change)
- Compare `contentHash` to detect changes
- If changed: delete old vector store file, upload new one
- If unchanged: skip

### Slack (messages are immutable)
- Just check if document exists in Firestore
- If exists: skip
- If not: upload

---

## 11. Error Handling

- **Rate limits**: Implement exponential backoff (Notion: 3 req/sec, Slack: tier-based)
- **Partial failures**: Log error, continue with next item, don't fail entire sync
- **Always update Firestore state**: Even on failure, record the error

---

## 12. NPM Dependencies

```json
{
  "@notionhq/client": "^2.2.0",
  "@slack/web-api": "^7.0.0",
  "openai": "^4.0.0",
  "@google-cloud/firestore": "^7.0.0",
  "@google-cloud/functions-framework": "^3.0.0"
}
```

---

## 13. Function Endpoints

| Function | Trigger | Purpose |
|----------|---------|---------|
| `syncKnowledgeBase` | Cloud Scheduler (every 6h) | Full incremental sync |
| `syncNotion` | HTTP (manual) | Sync only Notion |
| `syncSlack` | HTTP (manual) | Sync only Slack |
| `getSyncStatus` | HTTP | Return current sync state from Firestore |

---

## 14. Deployment Commands

```bash
# Deploy function
gcloud functions deploy syncKnowledgeBase \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-central1 \
  --trigger-http \
  --allow-unauthenticated \
  --set-secrets=OPENAI_API_KEY=OPENAI_API_KEY:latest,OPENAI_VECTOR_STORE_ID=OPENAI_VECTOR_STORE_ID:latest,NOTION_API_KEY=NOTION_API_KEY:latest,SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest \
  --timeout=540s \
  --memory=1Gi \
  --project=slack-agent-hub

# Create scheduler job
gcloud scheduler jobs create http sync-knowledge-base \
  --schedule="0 */6 * * *" \
  --uri="https://us-central1-slack-agent-hub.cloudfunctions.net/syncKnowledgeBase" \
  --http-method=POST \
  --location=us-central1 \
  --project=slack-agent-hub
```

---

## 15. Testing Approach

1. **Local testing**: Use functions-framework to run locally
2. **Manual trigger**: Call HTTP endpoint to trigger sync
3. **Verify in OpenAI**: Check vector store in OpenAI dashboard for uploaded files
4. **Query test**: Use OpenAI Playground with file_search to test retrieval

---

## 16. Monitoring

Log these events:
- Sync started/completed
- Documents added/updated/skipped/errored (with counts)
- API rate limit warnings
- Vector store file IDs created

Consider: Cloud Monitoring alerts for sync failures

---

## 17. Security Notes

- All secrets in Secret Manager, never in code
- Notion integration: read-only access
- Slack bot: minimal scopes (channels:read, channels:history, users:read)
- Cloud Function: consider requiring authentication for manual triggers

---

## 18. Consumer Information

The **MetricDashboard** repo will query this vector store using:
- OpenAI Assistants API with `file_search` tool
- Same `OPENAI_VECTOR_STORE_ID`: `vs_6941838e1f288191b75dbd9fd58df80a`
- Expects source metadata format: `[SOURCE:type|URL:url|TITLE:title]`

---

## 19. Initial Setup Checklist

- [ ] Create new repo/folder
- [ ] Initialize Node.js project with TypeScript
- [ ] Enable required GCP APIs
- [ ] Create secrets in Secret Manager
- [ ] Share Notion pages with integration (at notion.so/my-integrations)
- [ ] Slack bot already has required scopes
- [ ] Implement sync services
- [ ] Deploy to Cloud Functions
- [ ] Create Cloud Scheduler job
- [ ] Run initial sync
- [ ] Verify in OpenAI dashboard

