import { WebClient } from '@slack/web-api';
import {
  SlackMessage,
  SlackChannel,
  SlackThreadReply,
  SyncResult,
  KnowledgeDocument,
  SyncState,
  SyncStats,
} from '../types';
import { FirestoreService } from '../services/firestore.service';
import { VectorStoreProcessor } from '../processors/vectorStore.processor';
import { RateLimiter, calculateContentHash, withRetry, isRateLimitError, slackTsToDate } from '../utils';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const MIN_MESSAGE_LENGTH = 50;
const MESSAGES_PER_CHUNK = 100;  // Messages to fetch per API call
const TIMEOUT_BUFFER_MS = 5 * 60 * 1000;  // Stop 5 minutes before timeout
const MAX_RUNTIME_MS = 55 * 60 * 1000;    // 55 minutes max (Cloud Functions limit)

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
  '-purchases',
  '-updates',
];

// Channels where bot messages should be included
const BOT_WHITELIST_CHANNELS = [
  'daily-standup',
];

function isChannelBlacklisted(channelName: string): boolean {
  if (CHANNEL_BLACKLIST.includes(channelName)) return true;
  return CHANNEL_BLACKLIST_PATTERNS.some(pattern => channelName.endsWith(pattern));
}

// ═══════════════════════════════════════════════════════════════════════════
// SLACK SYNC CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class SlackSync {
  private slack: WebClient;
  private firestore: FirestoreService;
  private processor: VectorStoreProcessor;
  private rateLimiter: RateLimiter;
  private userCache: Map<string, string> = new Map();
  private startTime: number = 0;

  constructor(
    slackBotToken: string,
    openaiApiKey: string,
    vectorStoreId: string
  ) {
    this.slack = new WebClient(slackBotToken);
    this.firestore = new FirestoreService();
    this.processor = new VectorStoreProcessor(openaiApiKey, vectorStoreId, this.firestore);
    // Slack Tier 3 rate limit: ~50 req/min = 1 req/1.2sec
    this.rateLimiter = new RateLimiter(1, 1200);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN SYNC ENTRY POINT
  // ═══════════════════════════════════════════════════════════════════════════

  async sync(options: { maxMessages?: number } = {}): Promise<SyncResult> {
    this.startTime = Date.now();
    const { maxMessages } = options;

    const result: SyncResult = {
      source: 'slack',
      discovered: { total: 0, toAdd: 0, toUpdate: 0, toDelete: 0, unchanged: 0 },
      processed: { added: 0, updated: 0, deleted: 0, errored: 0 },
      errors: [],
      durationMs: 0,
    };

    try {
      // Initialize or resume sync
      const state = await this.initialize();

      // Get all channels (once per sync run)
      const channels = await this.getAllChannels();
      console.log(`Found ${channels.length} public channels`);

      // Process channels starting from checkpoint
      let totalProcessed = 0;
      const startIndex = state.currentChannelIndex || 0;

      for (let i = startIndex; i < channels.length; i++) {
        const channel = channels[i];

        // Check stop conditions
        if (await this.shouldStop()) {
          console.log('\n⏸️  Stopping: timeout or stop requested');
          await this.saveCheckpoint(state, i, null);
          await this.firestore.setTimeoutStatus('slack');
          // Return early - don't call complete()
          result.processed.added = state.stats?.added || 0;
          result.processed.updated = state.stats?.updated || 0;
          result.processed.deleted = state.stats?.deleted || 0;
          result.processed.errored = state.stats?.errored || 0;
          result.durationMs = Date.now() - this.startTime;
          console.log(`\n=== Slack Sync Paused in ${(result.durationMs / 1000).toFixed(1)}s ===`);
          console.log(`Results: +${result.processed.added} ~${result.processed.updated} -${result.processed.deleted} !${result.processed.errored}`);
          return result;
        }

        // Check maxMessages limit
        if (maxMessages && totalProcessed >= maxMessages) {
          console.log(`\n⏸️  Reached maxMessages limit (${maxMessages})`);
          break;
        }

        // Skip blacklisted channels
        if (isChannelBlacklisted(channel.name)) {
          console.log(`  #${channel.name}: skipped (blacklisted)`);
          continue;
        }

        // Process this channel
        console.log(`\n[Channel ${i + 1}/${channels.length}] #${channel.name}`);
        const channelCursor = i === startIndex ? (state.currentChannelCursor || null) : null;

        const processed = await this.processChannel(
          channel,
          state,
          channelCursor,
          maxMessages ? maxMessages - totalProcessed : undefined
        );

        totalProcessed += processed;

        // Save checkpoint after each channel
        await this.saveCheckpoint(state, i + 1, null);
      }

      // If we processed all channels, do delete phase
      const allChannelsProcessed = !maxMessages &&
        (state.currentChannelIndex || 0) >= channels.length - 1;

      if (allChannelsProcessed) {
        await this.deleteStaleDocuments(state);
      }

      // Complete sync
      await this.complete(state);

      // Build result
      result.processed.added = state.stats?.added || 0;
      result.processed.updated = state.stats?.updated || 0;
      result.processed.deleted = state.stats?.deleted || 0;
      result.processed.errored = state.stats?.errored || 0;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMsg);
      await this.firestore.failSync('slack', errorMsg);
      console.error('❌ Slack sync failed:', error);
    }

    result.durationMs = Date.now() - this.startTime;
    console.log(`\n=== Slack Sync Completed in ${(result.durationMs / 1000).toFixed(1)}s ===`);
    console.log(`Results: +${result.processed.added} ~${result.processed.updated} -${result.processed.deleted} !${result.processed.errored}`);

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZE / RESUME
  // ═══════════════════════════════════════════════════════════════════════════

  private async initialize(): Promise<SyncState> {
    const existing = await this.firestore.getSyncState('slack');

    // Resume from checkpoint? (status 'running' or 'timeout' with syncStartTime)
    if ((existing?.status === 'running' || existing?.status === 'timeout') && existing.syncStartTime) {
      // Resume from checkpoint
      console.log('=== Slack Sync RESUMING ===');
      console.log(`  Resuming from channel ${existing.currentChannelIndex || 0}`);
      return existing;
    }

    // Fresh start
    console.log('=== Slack Sync STARTING ===');
    const syncStartTime = new Date().toISOString();
    await this.firestore.startSync('slack', syncStartTime);

    return {
      lastSyncTimestamp: existing?.lastSyncTimestamp || null,
      status: 'running',
      totalDocuments: existing?.totalDocuments || 0,
      syncStartTime,
      stats: { processed: 0, added: 0, updated: 0, unchanged: 0, deleted: 0, errored: 0 },
      currentChannelIndex: 0,
      currentChannelCursor: null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STOP CONDITIONS
  // ═══════════════════════════════════════════════════════════════════════════

  private async shouldStop(): Promise<boolean> {
    // Check timeout
    const elapsed = Date.now() - this.startTime;
    if (elapsed > MAX_RUNTIME_MS - TIMEOUT_BUFFER_MS) {
      console.log('⏰ Approaching timeout');
      return true;
    }

    // Check kill switch
    const state = await this.firestore.getSyncState('slack');
    if (state?.stopRequested) {
      console.log('🛑 Stop requested');
      return true;
    }

    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESS CHANNEL
  // ═══════════════════════════════════════════════════════════════════════════

  private async processChannel(
    channel: SlackChannel,
    state: SyncState,
    cursor: string | null,
    maxMessages?: number
  ): Promise<number> {
    let processed = 0;
    let hasMore = true;
    let currentCursor = cursor;
    const isBotWhitelisted = BOT_WHITELIST_CHANNELS.includes(channel.name);

    try {
      // Try to join channel first (in case we're not a member)
      await this.joinChannel(channel.id);
    } catch (e) {
      // Ignore join errors
    }

    while (hasMore) {
      // Check stop conditions
      if (await this.shouldStop()) break;
      if (maxMessages && processed >= maxMessages) break;

      try {
        // Fetch chunk of messages
        const response = await this.rateLimiter.execute(() =>
          withRetry(
            () => this.slack.conversations.history({
              channel: channel.id,
              limit: MESSAGES_PER_CHUNK,
              cursor: currentCursor || undefined,
            }),
            { maxRetries: 3, retryOn: isRateLimitError }
          )
        );

        if (!response.messages || response.messages.length === 0) {
          hasMore = false;
          continue;
        }

        // Process each message
        for (const msg of response.messages) {
          if (maxMessages && processed >= maxMessages) break;

          try {
            const wasProcessed = await this.processMessage(msg, channel, state, isBotWhitelisted);
            if (wasProcessed) {
              processed++;
              state.stats!.processed++;
            }
          } catch (error) {
            console.error(`  ❌ Error processing message ${msg.ts}: ${error}`);
            state.stats!.errored++;
          }
        }

        // Update cursor for next iteration
        hasMore = response.has_more || false;
        currentCursor = response.response_metadata?.next_cursor || null;

        // Save checkpoint within channel
        if (hasMore) {
          await this.saveCheckpoint(state, state.currentChannelIndex || 0, currentCursor);
        }

      } catch (error: unknown) {
        const slackError = error as { data?: { error?: string } };
        if (slackError.data?.error === 'not_in_channel') {
          console.log(`    Cannot access #${channel.name}`);
        } else {
          console.error(`    Error: ${error}`);
        }
        hasMore = false;
      }
    }

    console.log(`  → Processed ${processed} messages`);
    return processed;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESS SINGLE MESSAGE
  // ═══════════════════════════════════════════════════════════════════════════

  private async processMessage(
    msg: any,
    channel: SlackChannel,
    state: SyncState,
    isBotWhitelisted: boolean
  ): Promise<boolean> {
    // Skip if missing timestamp
    if (!msg.ts) return false;

    // Extract text
    const text = this.extractMessageText(msg);
    if (!text || text.length < MIN_MESSAGE_LENGTH) return false;

    // Skip bot messages (unless whitelisted)
    if (msg.bot_id && !isBotWhitelisted) return false;

    // Skip subtypes (joins, leaves, etc.)
    if (msg.subtype && !(msg.subtype === 'bot_message' && isBotWhitelisted)) return false;

    const sourceId = `${channel.id}_${msg.ts.replace('.', '_')}`;
    const existing = await this.firestore.getDocument('slack', sourceId);

    // Get message metadata for change detection
    const replyCount = msg.reply_count || 0;
    const editedTs = msg.edited?.ts || null;

    if (!existing) {
      // NEW MESSAGE
      await this.syncNewMessage(msg, channel, state.syncStartTime!, sourceId, replyCount, editedTs);
      state.stats!.added++;
      console.log(`    + Added: ${channel.name}/${msg.ts}`);
      return true;

    } else if (!existing.vectorStoreFileId) {
      // INCOMPLETE (crashed during previous upload)
      await this.syncNewMessage(msg, channel, state.syncStartTime!, sourceId, replyCount, editedTs);
      state.stats!.added++;
      console.log(`    + Recovered: ${channel.name}/${msg.ts}`);
      return true;

    } else if (this.hasMessageChanged(existing, replyCount, editedTs)) {
      // UPDATED (new replies or edited)
      await this.syncUpdatedMessage(msg, channel, existing, state.syncStartTime!, replyCount, editedTs);
      state.stats!.updated++;
      console.log(`    ~ Updated: ${channel.name}/${msg.ts}`);
      return true;

    } else {
      // UNCHANGED - just mark as seen
      await this.firestore.markDocumentSeen('slack', sourceId);
      state.stats!.unchanged++;
      return false;
    }
  }

  private hasMessageChanged(existing: KnowledgeDocument, replyCount: number, editedTs: string | null): boolean {
    // Check if thread has new replies
    if (replyCount > (existing.replyCount || 0)) return true;

    // Check if message was edited
    if (editedTs && editedTs !== existing.editedTs) return true;

    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYNC NEW MESSAGE
  // ═══════════════════════════════════════════════════════════════════════════

  private async syncNewMessage(
    msg: any,
    channel: SlackChannel,
    syncStartTime: string,
    sourceId: string,
    replyCount: number,
    editedTs: string | null
  ): Promise<void> {
    // Get author name
    const authorName = msg.user
      ? await this.getUserName(msg.user)
      : (msg.username || 'Unknown');

    // Get thread replies if this is a thread parent
    let threadReplies: SlackThreadReply[] = [];
    if (msg.thread_ts === msg.ts && replyCount > 0) {
      threadReplies = await this.getThreadReplies(channel.id, msg.thread_ts);
    }

    // Get permalink
    const permalink = await this.getPermalink(channel.id, msg.ts);

    // Format content
    const formattedContent = VectorStoreProcessor.formatSlackContent({
      url: permalink,
      channelName: channel.name,
      authorName,
      timestamp: slackTsToDate(msg.ts).toISOString(),
      content: this.extractMessageText(msg),
      threadReplies: threadReplies.map(r => ({ authorName: r.authorName, text: r.text })),
    });

    const contentHash = calculateContentHash(formattedContent);

    // Create Firestore document first (without fileId)
    const doc: KnowledgeDocument = {
      sourceType: 'slack',
      sourceId,
      vectorStoreFileId: '',
      title: `Slack message in #${channel.name}`,
      url: permalink,
      lastModified: slackTsToDate(msg.ts).toISOString(),
      contentHash,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSeenAt: syncStartTime,
      replyCount,
      ...(editedTs && { editedTs }),  // Only include if defined
    };
    await this.firestore.saveDocument(doc);

    // Upload to OpenAI
    const fileId = await this.processor.uploadSingleFile(formattedContent, `slack_${sourceId}.txt`);
    console.log(`    Uploaded: slack_${sourceId}.txt -> ${fileId}`);

    // Update Firestore with fileId
    await this.firestore.updateDocument('slack', sourceId, {
      vectorStoreFileId: fileId,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYNC UPDATED MESSAGE
  // ═══════════════════════════════════════════════════════════════════════════

  private async syncUpdatedMessage(
    msg: any,
    channel: SlackChannel,
    existing: KnowledgeDocument,
    syncStartTime: string,
    replyCount: number,
    editedTs: string | null
  ): Promise<void> {
    // Get author name
    const authorName = msg.user
      ? await this.getUserName(msg.user)
      : (msg.username || 'Unknown');

    // Get thread replies
    let threadReplies: SlackThreadReply[] = [];
    if (msg.thread_ts === msg.ts && replyCount > 0) {
      threadReplies = await this.getThreadReplies(channel.id, msg.thread_ts);
    }

    // Format new content
    const formattedContent = VectorStoreProcessor.formatSlackContent({
      url: existing.url,
      channelName: channel.name,
      authorName,
      timestamp: slackTsToDate(msg.ts).toISOString(),
      content: this.extractMessageText(msg),
      threadReplies: threadReplies.map(r => ({ authorName: r.authorName, text: r.text })),
    });

    const contentHash = calculateContentHash(formattedContent);

    // Check if content actually changed
    if (contentHash === existing.contentHash) {
      // Just update metadata
      await this.firestore.updateDocument('slack', existing.sourceId, {
        lastSeenAt: syncStartTime,
        replyCount,
        ...(editedTs && { editedTs }),
      });
      return;
    }

    // Delete old file from OpenAI
    if (existing.vectorStoreFileId) {
      await this.processor.deleteSingleFile(existing.vectorStoreFileId);
    }

    // Upload new file
    const fileId = await this.processor.uploadSingleFile(formattedContent, `slack_${existing.sourceId}.txt`);
    console.log(`    Re-uploaded: slack_${existing.sourceId}.txt -> ${fileId}`);

    // Update Firestore
    await this.firestore.updateDocument('slack', existing.sourceId, {
      vectorStoreFileId: fileId,
      contentHash,
      updatedAt: new Date().toISOString(),
      lastSeenAt: syncStartTime,
      replyCount,
      ...(editedTs && { editedTs }),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE STALE DOCUMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  private async deleteStaleDocuments(state: SyncState): Promise<void> {
    console.log('\n[Delete Phase] Finding stale documents...');

    const staleDocs = await this.firestore.getStaleDocuments('slack', state.syncStartTime!);

    if (staleDocs.length === 0) {
      console.log('  No stale documents to delete');
      return;
    }

    console.log(`  Found ${staleDocs.length} stale documents to delete`);

    for (const doc of staleDocs) {
      try {
        // Delete from OpenAI
        if (doc.vectorStoreFileId) {
          await this.processor.deleteSingleFile(doc.vectorStoreFileId);
        }

        // Delete from Firestore
        await this.firestore.deleteDocumentBySource('slack', doc.sourceId);
        state.stats!.deleted++;
        console.log(`  - Deleted: ${doc.sourceId}`);
      } catch (error) {
        console.error(`  ❌ Failed to delete ${doc.sourceId}: ${error}`);
        state.stats!.errored++;
      }
    }

    console.log(`  Deleted ${state.stats!.deleted} stale documents`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHECKPOINTING
  // ═══════════════════════════════════════════════════════════════════════════

  private async saveCheckpoint(
    state: SyncState,
    channelIndex: number,
    channelCursor: string | null
  ): Promise<void> {
    state.currentChannelIndex = channelIndex;
    state.currentChannelCursor = channelCursor;
    await this.firestore.saveCheckpoint('slack', channelCursor, state.stats!);

    // Also save channel index via updateSyncState
    await this.firestore.updateSyncState('slack', {
      currentChannelIndex: channelIndex,
      currentChannelCursor: channelCursor,
    });
  }

  private async complete(state: SyncState): Promise<void> {
    const totalDocs = await this.firestore.getDocumentCount('slack');
    await this.firestore.completeSync(
      'slack',
      new Date().toISOString(),
      totalDocs
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  private extractMessageText(msg: any): string {
    const parts: string[] = [];

    if (msg.text && msg.text.trim().length > 0) {
      parts.push(msg.text);
    }

    if (msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        if (att.pretext) parts.push(att.pretext);
        if (att.title && att.text) {
          parts.push(`${att.title}: ${att.text}`);
        } else if (att.text) {
          parts.push(att.text);
        } else if (att.fallback && !att.is_app_unfurl) {
          parts.push(att.fallback);
        }
      }
    }

    return parts.join('\n\n');
  }

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

  private async joinChannel(channelId: string): Promise<boolean> {
    try {
      await this.rateLimiter.execute(() =>
        this.slack.conversations.join({ channel: channelId })
      );
      return true;
    } catch {
      return false;
    }
  }

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
        // Skip first message (it's the parent)
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
      console.warn(`    Could not fetch thread replies: ${error}`);
    }

    return replies;
  }

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
