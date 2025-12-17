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

export interface NotionPage {
  id: string;
  title: string;
  url: string;
  lastEditedTime: string;
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

// Sync results

export interface SyncResult {
  source: 'notion' | 'slack';
  added: number;
  updated: number;
  skipped: number;
  errored: number;
  errors: string[];
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



