// Firestore document types

export interface SyncState {
  lastSyncTimestamp: string | null;
  status: 'idle' | 'running' | 'completed' | 'failed';
  totalDocuments: number;
  lastError?: string;
  lastRunAt?: string;
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
