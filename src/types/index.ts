// Firestore document types

export interface SyncState {
  lastSyncTimestamp: string | null;
  status: 'idle' | 'running' | 'completed' | 'failed';
  totalDocuments: number;
  lastError?: string;
  lastRunAt?: string;

  // Streaming sync support
  cursor?: string | null;           // API cursor for resuming (Notion page cursor, Slack message cursor)
  syncStartTime?: string | null;    // When this sync run started (for delete detection)
  stopRequested?: boolean;          // Kill switch
  stats?: SyncStats;

  // Slack-specific: track which channel we're processing
  currentChannelIndex?: number;     // Index into channel list
  currentChannelCursor?: string | null;  // Cursor within current channel
}

export interface SyncStats {
  processed: number;
  added: number;
  updated: number;
  unchanged: number;
  deleted: number;
  errored: number;
}

export interface KnowledgeDocument {
  sourceType: 'notion' | 'slack';
  sourceId: string;
  vectorStoreFileId: string;
  title: string;
  url: string;
  lastModified: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;  // When this doc was last confirmed to exist in source

  // Slack-specific fields for change detection
  replyCount?: number;    // Number of thread replies (to detect new replies)
  editedTs?: string;      // Timestamp of last edit (to detect edits)
}

// Notion types

export interface NotionPageMeta {
  id: string;
  title: string;
  url: string;
  lastEditedTime: string;
}

export interface NotionPage extends NotionPageMeta {
  content: string;
}

// Slack types

export interface SlackMessage {
  channelId: string;
  channelName: string;
  messageTs: string;
  authorId: string;
  authorName: string;
  text: string;
  threadReplies?: SlackThreadReply[];
  permalink: string;
  timestamp: string;

  // For change detection
  replyCount?: number;    // Number of thread replies
  editedTs?: string;      // Timestamp of last edit (if edited)
}

export interface SlackThreadReply {
  authorName: string;
  text: string;
  timestamp: string;
}

export interface SlackChannel {
  id: string;
  name: string;
}

// Sync diff types

export interface SyncDiff<T> {
  toAdd: T[];
  toUpdate: T[];
  toDelete: string[]; // IDs to delete
  unchanged: number;
}

// Vector store queue types

export type VectorStoreOperation =
  | { type: 'upload'; id: string; content: string; filename: string; source: 'notion' | 'slack' }
  | { type: 'delete'; fileId: string; docId: string };

export interface QueueResult {
  operation: VectorStoreOperation;
  success: boolean;
  fileId?: string;
  error?: string;
}

// Sync results

export interface SyncResult {
  source: 'notion' | 'slack';
  discovered: {
    total: number;
    toAdd: number;
    toUpdate: number;
    toDelete: number;
    unchanged: number;
  };
  processed: {
    added: number;
    updated: number;
    deleted: number;
    errored: number;
  };
  errors: string[];
  durationMs: number;
}

// Config

export interface Config {
  openaiApiKey: string;
  openaiVectorStoreId: string;
  notionApiKey: string;
  slackBotToken: string;
}

// Vector Store types

export interface VectorStoreFile {
  id: string;
  status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
}
