import { WebClient } from '@slack/web-api';
import { SlackMessage, SlackChannel, SlackThreadReply, SyncResult, KnowledgeDocument } from '../types';
import { FirestoreService } from './firestore.service';
import { VectorStoreService } from './vectorStore.service';
import { RateLimiter, calculateContentHash, withRetry, isRateLimitError, slackTsToDate } from '../utils';

const MIN_MESSAGE_LENGTH = 50;

export class SlackService {
  private slack: WebClient;
  private firestore: FirestoreService;
  private vectorStore: VectorStoreService;
  private rateLimiter: RateLimiter;
  private userCache: Map<string, string> = new Map();

  constructor(
    slackBotToken: string,
    openaiApiKey: string,
    vectorStoreId: string
  ) {
    this.slack = new WebClient(slackBotToken);
    this.firestore = new FirestoreService();
    this.vectorStore = new VectorStoreService(openaiApiKey, vectorStoreId);
    // Slack rate limits vary by tier, using conservative limit
    this.rateLimiter = new RateLimiter(1, 500);
  }

  /**
   * Run the full Slack sync process
   */
  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      source: 'slack',
      added: 0,
      updated: 0,
      skipped: 0,
      errored: 0,
      errors: [],
    };

    console.log('Starting Slack sync...');

    try {
      await this.firestore.startSync('slack');

      // Get last sync timestamp
      const syncState = await this.firestore.getSyncState('slack');
      const lastSyncTimestamp = syncState?.lastSyncTimestamp || null;
      
      console.log(`Last sync timestamp: ${lastSyncTimestamp || 'none (first sync)'}`);

      // Get all public channels
      const channels = await this.getAllChannels();
      console.log(`Found ${channels.length} public channels`);

      let latestTimestamp = lastSyncTimestamp;

      // Process each channel
      for (const channel of channels) {
        try {
          console.log(`Processing channel: #${channel.name} (${channel.id})`);
          
          const channelResult = await this.processChannel(channel, lastSyncTimestamp);
          
          result.added += channelResult.added;
          result.skipped += channelResult.skipped;
          result.errored += channelResult.errored;
          result.errors.push(...channelResult.errors);

          // Track the latest timestamp
          if (channelResult.latestTimestamp) {
            if (!latestTimestamp || channelResult.latestTimestamp > latestTimestamp) {
              latestTimestamp = channelResult.latestTimestamp;
            }
          }
        } catch (error) {
          result.errored++;
          const errorMsg = `Error processing channel ${channel.name}: ${error}`;
          result.errors.push(errorMsg);
          console.error(errorMsg);
        }
      }

      // Update sync state
      const totalDocs = await this.firestore.getDocumentCount('slack');
      await this.firestore.completeSync(
        'slack',
        latestTimestamp || new Date().toISOString(),
        totalDocs
      );

      console.log(`Slack sync completed: ${JSON.stringify(result)}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.firestore.failSync('slack', errorMsg);
      throw error;
    }

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
            channels.push({
              id: channel.id,
              name: channel.name,
            });
          }
        }
      }

      cursor = response.response_metadata?.next_cursor;
    } while (cursor);

    return channels;
  }

  /**
   * Try to join a channel (for public channels)
   */
  private async joinChannel(channelId: string): Promise<boolean> {
    try {
      await this.rateLimiter.execute(() =>
        this.slack.conversations.join({ channel: channelId })
      );
      console.log(`Joined channel: ${channelId}`);
      return true;
    } catch (error) {
      // If we can't join, that's okay - we'll skip this channel
      return false;
    }
  }

  /**
   * Process a single channel
   */
  private async processChannel(
    channel: SlackChannel,
    sinceTimestamp: string | null
  ): Promise<{
    added: number;
    skipped: number;
    errored: number;
    errors: string[];
    latestTimestamp: string | null;
  }> {
    const result = {
      added: 0,
      skipped: 0,
      errored: 0,
      errors: [] as string[],
      latestTimestamp: null as string | null,
    };

    // Convert ISO timestamp to Slack timestamp format
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
          for (const message of response.messages) {
            try {
              const processResult = await this.processMessage(message, channel);
              
              if (processResult === 'added') {
                result.added++;
              } else if (processResult === 'skipped') {
                result.skipped++;
              }

              // Track latest timestamp
              if (message.ts) {
                const msgTimestamp = slackTsToDate(message.ts).toISOString();
                if (!result.latestTimestamp || msgTimestamp > result.latestTimestamp) {
                  result.latestTimestamp = msgTimestamp;
                }
              }
            } catch (error) {
              result.errored++;
              const errorMsg = `Error processing message ${message.ts}: ${error}`;
              result.errors.push(errorMsg);
              console.error(errorMsg);
            }
          }
        }

        hasMore = response.has_more || false;
        cursor = response.response_metadata?.next_cursor;
      } catch (error: unknown) {
        // Check if it's a "not_in_channel" error and try to join
        const slackError = error as { data?: { error?: string } };
        if (slackError.data?.error === 'not_in_channel' && !joinAttempted) {
          joinAttempted = true;
          console.log(`Not in channel ${channel.name}, attempting to join...`);
          const joined = await this.joinChannel(channel.id);
          if (joined) {
            // Retry after joining
            continue;
          }
        }
        // Log error but continue with other channels
        console.error(`Error fetching history for ${channel.name}:`, error);
        hasMore = false;
      }
    }

    return result;
  }

  /**
   * Process a single message
   */
  private async processMessage(
    message: {
      ts?: string;
      text?: string;
      user?: string;
      bot_id?: string;
      thread_ts?: string;
      reply_count?: number;
      subtype?: string;
    },
    channel: SlackChannel
  ): Promise<'added' | 'skipped'> {
    // Skip messages without required fields
    if (!message.ts || !message.text) {
      return 'skipped';
    }

    // Skip bot messages
    if (message.bot_id) {
      return 'skipped';
    }

    // Skip messages that are subtypes (joins, leaves, etc.)
    if (message.subtype) {
      return 'skipped';
    }

    // Skip short messages
    if (message.text.length < MIN_MESSAGE_LENGTH) {
      return 'skipped';
    }

    // Create unique source ID for the message
    const sourceId = `${channel.id}_${message.ts.replace('.', '_')}`;

    // Check if already processed (Slack messages are immutable)
    const existingDoc = await this.firestore.getDocument('slack', sourceId);
    if (existingDoc) {
      return 'skipped';
    }

    // Get author name
    const authorName = message.user 
      ? await this.getUserName(message.user)
      : 'Unknown';

    // Get thread replies if any
    let threadReplies: SlackThreadReply[] = [];
    if (message.thread_ts === message.ts && message.reply_count && message.reply_count > 0) {
      threadReplies = await this.getThreadReplies(channel.id, message.thread_ts);
    }

    // Get permalink
    const permalink = await this.getPermalink(channel.id, message.ts);

    // Build the Slack message object
    const slackMessage: SlackMessage = {
      channelId: channel.id,
      channelName: channel.name,
      messageTs: message.ts,
      authorId: message.user || 'unknown',
      authorName,
      text: message.text,
      threadReplies,
      permalink,
      timestamp: slackTsToDate(message.ts).toISOString(),
    };

    // Format and upload to vector store
    console.log(`Adding Slack message from #${channel.name}: ${message.text.substring(0, 50)}...`);

    const formattedContent = this.vectorStore.formatSlackContent({
      url: permalink,
      channelName: channel.name,
      authorName,
      timestamp: slackMessage.timestamp,
      content: message.text,
      threadReplies: threadReplies.map(r => ({ authorName: r.authorName, text: r.text })),
    });

    const contentHash = calculateContentHash(formattedContent);

    const fileId = await this.vectorStore.uploadFile(
      formattedContent,
      `slack_${sourceId}.txt`
    );

    // Save to Firestore
    const newDoc: KnowledgeDocument = {
      sourceType: 'slack',
      sourceId,
      vectorStoreFileId: fileId,
      title: `Slack message in #${channel.name}`,
      url: permalink,
      lastModified: slackMessage.timestamp,
      contentHash,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.firestore.saveDocument(newDoc);
    return 'added';
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
        // Skip the first message (it's the parent)
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
    // Check cache first
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
    } catch (error) {
      console.warn(`Could not fetch user info for ${userId}:`, error);
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
    } catch (error) {
      // Fallback to constructed URL
      return `https://slack.com/archives/${channelId}/p${messageTs.replace('.', '')}`;
    }
  }
}


