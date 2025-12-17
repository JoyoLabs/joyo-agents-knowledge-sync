import { WebClient } from '@slack/web-api';
import {
  SlackMessage,
  SlackChannel,
  SlackThreadReply,
  SyncResult,
  VectorStoreOperation,
  KnowledgeDocument,
} from '../types';
import { FirestoreService } from '../services/firestore.service';
import { VectorStoreProcessor } from '../processors/vectorStore.processor';
import { RateLimiter, calculateContentHash, withRetry, isRateLimitError, slackTsToDate } from '../utils';

const MIN_MESSAGE_LENGTH = 50;

// Channels to skip entirely (automation-only, no human content)
const CHANNEL_BLACKLIST = [
  'linear-updates',
  'github-updates',
  'new_update_alert',
  'service-outages',
  'google-cloud-outages',
  'google-ads-outages',
];

// Channel name patterns to skip (matched as suffixes)
const CHANNEL_BLACKLIST_PATTERNS = [
  '-purchases',  // Purchase notification channels
  '-updates',    // Automated update channels
];

// Channels where bot messages should be included (standup bots post on behalf of users)
const BOT_WHITELIST_CHANNELS = [
  'daily-standup',
];

function isChannelBlacklisted(channelName: string): boolean {
  if (CHANNEL_BLACKLIST.includes(channelName)) return true;
  return CHANNEL_BLACKLIST_PATTERNS.some(pattern => channelName.endsWith(pattern));
}

/**
 * Extract text content from a message, including attachments
 */
function extractMessageText(msg: any): string {
  const parts: string[] = [];

  // Include main text if available
  if (msg.text && msg.text.trim().length > 0) {
    parts.push(msg.text);
  }

  // Always include attachment text (link previews, standup content, etc.)
  if (msg.attachments && msg.attachments.length > 0) {
    for (const att of msg.attachments) {
      if (att.pretext) parts.push(att.pretext);
      if (att.title && att.text) {
        parts.push(`${att.title}: ${att.text}`);
      } else if (att.text) {
        parts.push(att.text);
      } else if (att.fallback && !att.is_app_unfurl) {
        // Include fallback but skip app unfurls (Notion, Linear previews already in URL)
        parts.push(att.fallback);
      }
    }
  }

  return parts.join('\n\n');
}

export class SlackSync {
  private slack: WebClient;
  private firestore: FirestoreService;
  private processor: VectorStoreProcessor;
  private rateLimiter: RateLimiter;
  private userCache: Map<string, string> = new Map();

  constructor(
    slackBotToken: string,
    openaiApiKey: string,
    vectorStoreId: string
  ) {
    this.slack = new WebClient(slackBotToken);
    this.firestore = new FirestoreService();
    this.processor = new VectorStoreProcessor(openaiApiKey, vectorStoreId, this.firestore);
    // Slack rate limits vary by tier, using conservative limit
    this.rateLimiter = new RateLimiter(1, 500);
  }

  /**
   * Main sync entry point
   */
  async sync(): Promise<SyncResult> {
    const startTime = Date.now();
    const result: SyncResult = {
      source: 'slack',
      discovered: { total: 0, toAdd: 0, toUpdate: 0, toDelete: 0, unchanged: 0 },
      processed: { added: 0, updated: 0, deleted: 0, errored: 0 },
      errors: [],
      durationMs: 0,
    };

    console.log('=== Slack Sync Started ===');

    try {
      // Get last sync timestamp first (before starting new sync)
      const syncState = await this.firestore.getSyncState('slack');
      const lastSyncTimestamp = syncState?.lastSyncTimestamp || null;

      await this.firestore.startSync('slack', new Date().toISOString());
      console.log(`Last sync timestamp: ${lastSyncTimestamp || 'none (first sync)'}`);

      // Phase 1: Get all public channels
      console.log('\n[Phase 1] Discovering channels...');
      const channels = await this.getAllChannels();
      console.log(`Found ${channels.length} public channels`);

      // Phase 2: Discover new messages across all channels
      console.log('\n[Phase 2] Discovering new messages...');
      const { messages, latestTimestamp } = await this.discoverNewMessages(channels, lastSyncTimestamp);

      result.discovered.total = messages.length;
      result.discovered.toAdd = messages.length;
      console.log(`Discovered ${messages.length} new messages to sync`);

      // Phase 3: Build and process queue
      if (messages.length > 0) {
        console.log('\n[Phase 3] Processing vector store operations...');
        const operations = await this.buildOperations(messages);
        console.log(`Queued ${operations.length} operations`);

        const queueResults = await this.processor.processQueue(operations);

        for (const qr of queueResults) {
          if (qr.success) {
            result.processed.added++;
          } else {
            result.processed.errored++;
            result.errors.push(qr.error || 'Unknown error');
          }
        }
      }

      // Update sync state
      const totalDocs = await this.firestore.getDocumentCount('slack');
      await this.firestore.completeSync(
        'slack',
        latestTimestamp || new Date().toISOString(),
        totalDocs
      );

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMsg);
      await this.firestore.failSync('slack', errorMsg);
      console.error('Slack sync failed:', error);
    }

    result.durationMs = Date.now() - startTime;
    console.log(`\n=== Slack Sync Completed in ${(result.durationMs / 1000).toFixed(1)}s ===`);
    console.log(`Results: +${result.processed.added} !${result.processed.errored}`);

    return result;
  }

  /**
   * Get all public channels
   */
  private async getAllChannels(): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.rateLimiter.execute(() =>
        withRetry(
          () => this.slack.conversations.list({
            types: 'public_channel',
            exclude_archived: true,
            limit: 200,
            cursor,
          }),
          { maxRetries: 3, retryOn: isRateLimitError }
        )
      );

      if (response.channels) {
        for (const channel of response.channels) {
          if (channel.id && channel.name) {
            channels.push({ id: channel.id, name: channel.name });
          }
        }
      }

      cursor = response.response_metadata?.next_cursor;
    } while (cursor);

    return channels;
  }

  /**
   * Discover all new messages across channels
   */
  private async discoverNewMessages(
    channels: SlackChannel[],
    sinceTimestamp: string | null
  ): Promise<{ messages: SlackMessage[]; latestTimestamp: string | null }> {
    const messages: SlackMessage[] = [];
    let latestTimestamp = sinceTimestamp;

    // Get existing message IDs from Firestore for quick lookup
    const existingDocs = await this.firestore.getDocumentIdMap('slack');
    const existingIds = new Set(existingDocs.keys());

    for (const channel of channels) {
      // Skip blacklisted channels
      if (isChannelBlacklisted(channel.name)) {
        console.log(`  #${channel.name}: skipped (blacklisted)`);
        continue;
      }

      try {
        const channelMessages = await this.getChannelMessages(channel, sinceTimestamp, existingIds);
        messages.push(...channelMessages);

        // Track latest timestamp
        for (const msg of channelMessages) {
          if (!latestTimestamp || msg.timestamp > latestTimestamp) {
            latestTimestamp = msg.timestamp;
          }
        }

        console.log(`  #${channel.name}: ${channelMessages.length} new messages`);
      } catch (error) {
        console.error(`  Error fetching #${channel.name}: ${error}`);
      }
    }

    return { messages, latestTimestamp };
  }

  /**
   * Get new messages from a single channel
   */
  private async getChannelMessages(
    channel: SlackChannel,
    sinceTimestamp: string | null,
    existingIds: Set<string>
  ): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    const oldest = sinceTimestamp
      ? (new Date(sinceTimestamp).getTime() / 1000).toString()
      : undefined;

    let cursor: string | undefined;
    let hasMore = true;
    let joinAttempted = false;

    while (hasMore) {
      try {
        const response = await this.rateLimiter.execute(() =>
          withRetry(
            () => this.slack.conversations.history({
              channel: channel.id,
              oldest,
              limit: 200,
              cursor,
            }),
            { maxRetries: 3, retryOn: isRateLimitError }
          )
        );

        if (response.messages) {
          const isBotWhitelisted = BOT_WHITELIST_CHANNELS.includes(channel.name);

          for (const msg of response.messages) {
            // Skip if missing timestamp
            if (!msg.ts) continue;

            // Extract text (from msg.text or attachments)
            const text = extractMessageText(msg);

            // Skip if no text content
            if (!text || text.length < MIN_MESSAGE_LENGTH) continue;

            // Skip bot messages (unless channel is whitelisted for bots)
            if (msg.bot_id && !isBotWhitelisted) continue;

            // Skip subtypes (joins, leaves, etc.) - but allow bot_message in whitelisted channels
            if (msg.subtype && !(msg.subtype === 'bot_message' && isBotWhitelisted)) continue;

            const sourceId = `${channel.id}_${msg.ts.replace('.', '_')}`;

            // Skip if already in Firestore
            if (existingIds.has(sourceId)) continue;

            // Get additional message details
            const authorName = msg.user
              ? await this.getUserName(msg.user)
              : (msg.username || 'Unknown');

            let threadReplies: SlackThreadReply[] = [];
            if (msg.thread_ts === msg.ts && msg.reply_count && msg.reply_count > 0) {
              threadReplies = await this.getThreadReplies(channel.id, msg.thread_ts);
            }

            const permalink = await this.getPermalink(channel.id, msg.ts);

            messages.push({
              channelId: channel.id,
              channelName: channel.name,
              messageTs: msg.ts,
              authorId: msg.user || 'unknown',
              authorName,
              text,
              threadReplies,
              permalink,
              timestamp: slackTsToDate(msg.ts).toISOString(),
            });
          }
        }

        hasMore = response.has_more || false;
        cursor = response.response_metadata?.next_cursor;
      } catch (error: unknown) {
        const slackError = error as { data?: { error?: string } };
        if (slackError.data?.error === 'not_in_channel' && !joinAttempted) {
          joinAttempted = true;
          const joined = await this.joinChannel(channel.id);
          if (joined) continue;
        }
        hasMore = false;
      }
    }

    return messages;
  }

  /**
   * Build vector store operations for messages
   */
  private async buildOperations(messages: SlackMessage[]): Promise<VectorStoreOperation[]> {
    const operations: VectorStoreOperation[] = [];

    for (const msg of messages) {
      const sourceId = `${msg.channelId}_${msg.messageTs.replace('.', '_')}`;

      const formattedContent = VectorStoreProcessor.formatSlackContent({
        url: msg.permalink,
        channelName: msg.channelName,
        authorName: msg.authorName,
        timestamp: msg.timestamp,
        content: msg.text,
        threadReplies: msg.threadReplies?.map(r => ({ authorName: r.authorName, text: r.text })),
      });

      const contentHash = calculateContentHash(formattedContent);

      // Create Firestore document first
      const newDoc: KnowledgeDocument = {
        sourceType: 'slack',
        sourceId,
        vectorStoreFileId: '', // Will be updated after upload
        title: `Slack message in #${msg.channelName}`,
        url: msg.permalink,
        lastModified: msg.timestamp,
        contentHash,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await this.firestore.saveDocument(newDoc);

      operations.push({
        type: 'upload',
        id: sourceId,
        content: formattedContent,
        filename: `slack_${sourceId}.txt`,
        source: 'slack',
      });
    }

    return operations;
  }

  /**
   * Try to join a channel
   */
  private async joinChannel(channelId: string): Promise<boolean> {
    try {
      await this.rateLimiter.execute(() =>
        this.slack.conversations.join({ channel: channelId })
      );
      console.log(`Joined channel: ${channelId}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get thread replies for a message
   */
  private async getThreadReplies(channelId: string, threadTs: string): Promise<SlackThreadReply[]> {
    const replies: SlackThreadReply[] = [];

    try {
      const response = await this.rateLimiter.execute(() =>
        withRetry(
          () => this.slack.conversations.replies({
            channel: channelId,
            ts: threadTs,
            limit: 100,
          }),
          { maxRetries: 3, retryOn: isRateLimitError }
        )
      );

      if (response.messages) {
        for (const reply of response.messages.slice(1)) {
          if (reply.text && reply.ts) {
            const authorName = reply.user
              ? await this.getUserName(reply.user)
              : 'Unknown';

            replies.push({
              authorName,
              text: reply.text,
              timestamp: slackTsToDate(reply.ts).toISOString(),
            });
          }
        }
      }
    } catch (error) {
      console.warn(`Could not fetch thread replies for ${threadTs}:`, error);
    }

    return replies;
  }

  /**
   * Get user's display name (with caching)
   */
  private async getUserName(userId: string): Promise<string> {
    if (this.userCache.has(userId)) {
      return this.userCache.get(userId)!;
    }

    try {
      const response = await this.rateLimiter.execute(() =>
        withRetry(
          () => this.slack.users.info({ user: userId }),
          { maxRetries: 3, retryOn: isRateLimitError }
        )
      );

      const name = response.user?.real_name || response.user?.name || userId;
      this.userCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  /**
   * Get permalink for a message
   */
  private async getPermalink(channelId: string, messageTs: string): Promise<string> {
    try {
      const response = await this.rateLimiter.execute(() =>
        withRetry(
          () => this.slack.chat.getPermalink({
            channel: channelId,
            message_ts: messageTs,
          }),
          { maxRetries: 3, retryOn: isRateLimitError }
        )
      );

      return response.permalink || `https://slack.com/archives/${channelId}/p${messageTs.replace('.', '')}`;
    } catch {
      return `https://slack.com/archives/${channelId}/p${messageTs.replace('.', '')}`;
    }
  }
}
