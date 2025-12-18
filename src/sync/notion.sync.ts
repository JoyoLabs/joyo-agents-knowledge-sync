import { Client } from '@notionhq/client';
import {
  PageObjectResponse,
  BlockObjectResponse,
  RichTextItemResponse,
  PartialBlockObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';
import {
  NotionPageMeta,
  SyncResult,
  SyncStats,
  KnowledgeDocument,
} from '../types';
import { FirestoreService } from '../services/firestore.service';
import { VectorStoreProcessor } from '../processors/vectorStore.processor';
import { RateLimiter, calculateContentHash, withRetry, isRateLimitError } from '../utils';

// Configuration
const CHUNK_SIZE = 20;                    // Pages per Notion API call
const MAX_RUNTIME_MS = 55 * 60 * 1000;    // 55 minutes (leave buffer before 60 min timeout)

export class NotionSync {
  private notion: Client;
  private firestore: FirestoreService;
  private processor: VectorStoreProcessor;
  private rateLimiter: RateLimiter;
  private startTime: number = 0;

  constructor(
    notionApiKey: string,
    openaiApiKey: string,
    vectorStoreId: string
  ) {
    this.notion = new Client({ auth: notionApiKey });
    this.firestore = new FirestoreService();
    this.processor = new VectorStoreProcessor(openaiApiKey, vectorStoreId, this.firestore);
    this.rateLimiter = new RateLimiter(3, 1000); // Notion: 3 requests per 1 second
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN SYNC METHOD
  // ═══════════════════════════════════════════════════════════════════════════

  async sync(options?: { maxPages?: number }): Promise<SyncResult> {
    const maxPages = options?.maxPages;
    this.startTime = Date.now();

    const result: SyncResult = {
      source: 'notion',
      discovered: { total: 0, toAdd: 0, toUpdate: 0, toDelete: 0, unchanged: 0 },
      processed: { added: 0, updated: 0, deleted: 0, errored: 0 },
      errors: [],
      durationMs: 0,
    };

    try {
      // ─────────────────────────────────────────────────────────────────────
      // 1. INITIALIZE (resume or fresh start)
      // ─────────────────────────────────────────────────────────────────────
      const state = await this.initialize();
      console.log(`=== Notion Sync ${state.isResume ? 'RESUMING' : 'STARTING'} ===`);
      if (state.isResume) {
        console.log(`  Resuming from cursor, ${state.stats.processed} pages already done`);
      }

      // ─────────────────────────────────────────────────────────────────────
      // 2. PROCESS CHUNKS (main streaming loop)
      // ─────────────────────────────────────────────────────────────────────
      let hasMore = true;

      while (hasMore) {
        // Check if we should stop
        const stopReason = await this.shouldStop();
        if (stopReason) {
          console.log(`\n⏸️  Stopping: ${stopReason}`);
          await this.firestore.saveCheckpoint('notion', state.cursor, state.stats);
          await this.firestore.setTimeoutStatus('notion');
          result.processed = {
            added: state.stats.added,
            updated: state.stats.updated,
            deleted: state.stats.deleted,
            errored: state.stats.errored,
          };
          result.durationMs = Date.now() - this.startTime;
          result.errors.push(`Sync paused: ${stopReason}`);
          return result;
        }

        // Fetch and process one chunk
        const chunkResult = await this.processChunk(state, maxPages);
        hasMore = chunkResult.hasMore;
        state.cursor = chunkResult.nextCursor;

        // Save checkpoint (safe to kill after this)
        await this.firestore.saveCheckpoint('notion', state.cursor, state.stats);
        console.log(`  ✓ Checkpoint: ${state.stats.processed} pages processed`);
      }

      // ─────────────────────────────────────────────────────────────────────
      // 3. DELETE STALE DOCUMENTS
      // ─────────────────────────────────────────────────────────────────────
      console.log('\n[Delete Phase] Finding stale documents...');
      const deleteCount = await this.deleteStaleDocuments(state.syncStartTime);
      state.stats.deleted = deleteCount;
      console.log(`  Deleted ${deleteCount} stale documents`);

      // ─────────────────────────────────────────────────────────────────────
      // 4. COMPLETE
      // ─────────────────────────────────────────────────────────────────────
      const totalDocs = await this.firestore.getDocumentCount('notion');
      await this.firestore.completeSync(
        'notion',
        new Date().toISOString(),
        totalDocs,
        state.stats
      );

      result.discovered.total = state.stats.processed;
      result.discovered.toAdd = state.stats.added;
      result.discovered.toUpdate = state.stats.updated;
      result.discovered.toDelete = state.stats.deleted;
      result.discovered.unchanged = state.stats.unchanged;
      result.processed = {
        added: state.stats.added,
        updated: state.stats.updated,
        deleted: state.stats.deleted,
        errored: state.stats.errored,
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMsg);
      await this.firestore.failSync('notion', errorMsg);
      console.error('❌ Notion sync failed:', error);
    }

    result.durationMs = Date.now() - this.startTime;
    console.log(`\n=== Notion Sync Completed in ${(result.durationMs / 1000).toFixed(1)}s ===`);
    console.log(`Results: +${result.processed.added} ~${result.processed.updated} -${result.processed.deleted} !${result.processed.errored}`);

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  private async initialize(): Promise<{
    cursor: string | null;
    syncStartTime: string;
    stats: SyncStats;
    isResume: boolean;
  }> {
    const saved = await this.firestore.getSyncState('notion');

    // Resume from checkpoint? (status 'running' or 'timeout' with cursor)
    if ((saved?.status === 'running' || saved?.status === 'timeout') && saved.cursor && saved.syncStartTime) {
      return {
        cursor: saved.cursor,
        syncStartTime: saved.syncStartTime,
        stats: saved.stats || { processed: 0, added: 0, updated: 0, unchanged: 0, deleted: 0, errored: 0 },
        isResume: true,
      };
    }

    // Fresh start
    const syncStartTime = new Date().toISOString();
    await this.firestore.startSync('notion', syncStartTime);

    return {
      cursor: null,
      syncStartTime,
      stats: { processed: 0, added: 0, updated: 0, unchanged: 0, deleted: 0, errored: 0 },
      isResume: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SHOULD STOP CHECK
  // ═══════════════════════════════════════════════════════════════════════════

  private async shouldStop(): Promise<string | null> {
    // Check kill switch
    const state = await this.firestore.getSyncState('notion');
    if (state?.stopRequested) {
      return 'Stop requested by user';
    }

    // Check timeout
    const elapsed = Date.now() - this.startTime;
    if (elapsed > MAX_RUNTIME_MS) {
      return 'Approaching timeout, will resume next run';
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESS ONE CHUNK
  // ═══════════════════════════════════════════════════════════════════════════

  private async processChunk(
    state: {
      cursor: string | null;
      syncStartTime: string;
      stats: SyncStats;
    },
    maxPages?: number
  ): Promise<{ hasMore: boolean; nextCursor: string | null }> {

    // Fetch chunk from Notion (use smaller chunk if maxPages is set)
    const chunkSize = maxPages ? Math.min(CHUNK_SIZE, maxPages - state.stats.processed) : CHUNK_SIZE;
    const response = await this.fetchNotionChunk(state.cursor, chunkSize);
    const pages = this.filterPages(response.results);

    console.log(`\n[Chunk] Fetched ${pages.length} pages (cursor: ${state.cursor ? 'yes' : 'start'})`);

    // Process each page
    for (const page of pages) {
      // Check if we've hit the limit
      if (maxPages && state.stats.processed >= maxPages) {
        console.log(`  ⏸️  Reached maxPages limit (${maxPages})`);
        return { hasMore: false, nextCursor: null };
      }

      try {
        await this.processPage(page, state);
      } catch (error) {
        console.error(`  ❌ Failed to process page ${page.id}:`, error);
        state.stats.errored++;
      }
      state.stats.processed++;
    }

    // If we have a maxPages limit and we've reached it, stop
    if (maxPages && state.stats.processed >= maxPages) {
      return { hasMore: false, nextCursor: null };
    }

    return {
      hasMore: response.has_more,
      nextCursor: response.next_cursor || null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESS SINGLE PAGE
  // ═══════════════════════════════════════════════════════════════════════════

  private async processPage(
    page: NotionPageMeta,
    state: { syncStartTime: string; stats: SyncStats }
  ): Promise<void> {
    console.log(`  → Processing: ${page.title.substring(0, 50)}...`);
    const existing = await this.firestore.getDocument('notion', page.id);

    if (!existing) {
      // NEW PAGE
      await this.syncNewPage(page, state.syncStartTime);
      state.stats.added++;
      console.log(`  + Added: ${page.title.substring(0, 50)}`);

    } else if (!existing.vectorStoreFileId) {
      // INCOMPLETE (crashed during previous upload)
      await this.syncNewPage(page, state.syncStartTime);
      state.stats.added++;
      console.log(`  + Recovered: ${page.title.substring(0, 50)}`);

    } else if (page.lastEditedTime > existing.lastModified) {
      // UPDATED PAGE
      await this.syncUpdatedPage(page, existing, state.syncStartTime);
      state.stats.updated++;
      console.log(`  ~ Updated: ${page.title.substring(0, 50)}`);

    } else {
      // UNCHANGED - just mark as seen
      await this.firestore.markDocumentSeen('notion', page.id);
      state.stats.unchanged++;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYNC NEW PAGE
  // ═══════════════════════════════════════════════════════════════════════════

  private async syncNewPage(page: NotionPageMeta, syncStartTime: string): Promise<void> {
    // Fetch content
    const fetchStart = Date.now();
    const content = await this.getPageContent(page.id);
    console.log(`    ⏱ Content fetched in ${Date.now() - fetchStart}ms`);
    const contentHash = calculateContentHash(content);

    // Format for vector store
    const formattedContent = VectorStoreProcessor.formatNotionContent({
      url: page.url,
      title: page.title,
      content,
    });

    // Create document in Firestore first (without fileId)
    const doc: KnowledgeDocument = {
      sourceType: 'notion',
      sourceId: page.id,
      vectorStoreFileId: '',
      title: page.title,
      url: page.url,
      lastModified: page.lastEditedTime,
      contentHash,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSeenAt: syncStartTime,
    };
    await this.firestore.saveDocument(doc);

    // Upload to OpenAI
    const fileId = await this.processor.uploadSingleFile(formattedContent, `notion_${page.id}.txt`);

    // Update with fileId
    await this.firestore.updateDocument('notion', page.id, { vectorStoreFileId: fileId });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYNC UPDATED PAGE
  // ═══════════════════════════════════════════════════════════════════════════

  private async syncUpdatedPage(
    page: NotionPageMeta,
    existing: KnowledgeDocument,
    syncStartTime: string
  ): Promise<void> {
    // Fetch new content
    const fetchStart = Date.now();
    const content = await this.getPageContent(page.id);
    console.log(`    ⏱ Content fetched in ${Date.now() - fetchStart}ms`);
    const contentHash = calculateContentHash(content);

    // Check if content actually changed
    if (contentHash === existing.contentHash) {
      // Only metadata changed, just update timestamp
      await this.firestore.updateDocument('notion', page.id, {
        lastModified: page.lastEditedTime,
        lastSeenAt: syncStartTime,
      });
      return;
    }

    // Content changed - delete old file, upload new
    if (existing.vectorStoreFileId) {
      await this.processor.deleteSingleFile(existing.vectorStoreFileId);
    }

    const formattedContent = VectorStoreProcessor.formatNotionContent({
      url: page.url,
      title: page.title,
      content,
    });

    const fileId = await this.processor.uploadSingleFile(formattedContent, `notion_${page.id}.txt`);

    await this.firestore.updateDocument('notion', page.id, {
      vectorStoreFileId: fileId,
      title: page.title,
      lastModified: page.lastEditedTime,
      contentHash,
      lastSeenAt: syncStartTime,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE STALE DOCUMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  private async deleteStaleDocuments(syncStartTime: string): Promise<number> {
    // Get documents not seen in this sync run
    const staleDocs = await this.firestore.getStaleDocuments('notion', syncStartTime);

    // Also get documents without lastSeenAt (legacy docs before this feature)
    const legacyDocs = await this.firestore.getDocumentsWithoutLastSeen('notion');

    // Only delete staleDocs (legacy docs will get lastSeenAt on next sync)
    let deleted = 0;
    for (const doc of staleDocs) {
      try {
        if (doc.vectorStoreFileId) {
          await this.processor.deleteSingleFile(doc.vectorStoreFileId);
        }
        await this.firestore.deleteDocumentBySource('notion', doc.sourceId);
        deleted++;
        console.log(`  - Deleted stale: ${doc.title?.substring(0, 50) || doc.sourceId}`);
      } catch (error) {
        console.error(`  ❌ Failed to delete ${doc.sourceId}:`, error);
      }
    }

    if (legacyDocs.length > 0) {
      console.log(`  ℹ️  ${legacyDocs.length} legacy docs without lastSeenAt (will be updated on next sync)`);
    }

    return deleted;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NOTION API HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private async fetchNotionChunk(cursor: string | null, chunkSize: number = CHUNK_SIZE): Promise<{
    results: PageObjectResponse[];
    has_more: boolean;
    next_cursor: string | null;
  }> {
    const response = await this.rateLimiter.execute(() =>
      withRetry(
        () => this.notion.search({
          filter: { property: 'object', value: 'page' },
          sort: { direction: 'descending', timestamp: 'last_edited_time' },
          page_size: chunkSize,
          start_cursor: cursor || undefined,
        }),
        { maxRetries: 3, retryOn: isRateLimitError }
      )
    );

    return {
      results: response.results.filter(r => r.object === 'page') as PageObjectResponse[],
      has_more: response.has_more,
      next_cursor: response.next_cursor,
    };
  }

  private filterPages(results: PageObjectResponse[]): NotionPageMeta[] {
    const pages: NotionPageMeta[] = [];

    for (const page of results) {
      // Only include actual pages, not database rows
      const parentType = page.parent.type;
      if (parentType === 'database_id') {
        continue; // Skip database rows
      }

      pages.push({
        id: page.id,
        title: this.getPageTitle(page),
        url: page.url,
        lastEditedTime: page.last_edited_time,
      });
    }

    return pages;
  }

  private getPageTitle(page: PageObjectResponse): string {
    const properties = page.properties;

    for (const key of ['title', 'Title', 'Name', 'name']) {
      const prop = properties[key];
      if (prop && prop.type === 'title' && prop.title.length > 0) {
        return prop.title.map(t => t.plain_text).join('');
      }
    }

    for (const prop of Object.values(properties)) {
      if (prop.type === 'title' && prop.title.length > 0) {
        return prop.title.map(t => t.plain_text).join('');
      }
    }

    return 'Untitled';
  }

  private async getPageContent(pageId: string): Promise<string> {
    const blocks = await this.getAllBlocks(pageId);
    const textParts: string[] = [];

    for (const block of blocks) {
      const text = this.extractBlockText(block);
      if (text) {
        textParts.push(text);
      }
    }

    return textParts.join('\n\n') || 'No content';
  }

  private async getAllBlocks(blockId: string): Promise<BlockObjectResponse[]> {
    const blocks: BlockObjectResponse[] = [];
    let hasMore = true;
    let startCursor: string | undefined;

    while (hasMore) {
      const response = await this.rateLimiter.execute(() =>
        withRetry(
          () => this.notion.blocks.children.list({
            block_id: blockId,
            page_size: 100,
            start_cursor: startCursor,
          }),
          { maxRetries: 3, retryOn: isRateLimitError }
        )
      );

      for (const block of response.results) {
        if (this.isFullBlock(block)) {
          blocks.push(block);

          if (block.has_children) {
            const children = await this.getAllBlocks(block.id);
            blocks.push(...children);
          }
        }
      }

      hasMore = response.has_more;
      startCursor = response.next_cursor || undefined;
    }

    return blocks;
  }

  private isFullBlock(block: BlockObjectResponse | PartialBlockObjectResponse): block is BlockObjectResponse {
    return 'type' in block;
  }

  private extractBlockText(block: BlockObjectResponse): string | null {
    const type = block.type;

    const richTextBlocks = [
      'paragraph', 'heading_1', 'heading_2', 'heading_3',
      'bulleted_list_item', 'numbered_list_item', 'to_do',
      'toggle', 'quote', 'callout', 'code',
    ];

    if (richTextBlocks.includes(type)) {
      const blockData = block[type as keyof typeof block] as { rich_text?: RichTextItemResponse[] };
      if (blockData && 'rich_text' in blockData && blockData.rich_text) {
        const text = blockData.rich_text.map(rt => rt.plain_text).join('');

        if (type === 'heading_1') return `# ${text}`;
        if (type === 'heading_2') return `## ${text}`;
        if (type === 'heading_3') return `### ${text}`;
        if (type === 'bulleted_list_item') return `• ${text}`;
        if (type === 'numbered_list_item') return `- ${text}`;
        if (type === 'to_do') {
          const todo = block.to_do as { checked?: boolean };
          return `[${todo.checked ? 'x' : ' '}] ${text}`;
        }
        if (type === 'quote') return `> ${text}`;
        if (type === 'code') {
          const codeBlock = block.code as { language?: string };
          return `\`\`\`${codeBlock.language || ''}\n${text}\n\`\`\``;
        }

        return text;
      }
    }

    if (type === 'table_row') {
      const cells = (block.table_row as { cells?: RichTextItemResponse[][] }).cells;
      if (cells) {
        return cells.map(cell => cell.map(rt => rt.plain_text).join('')).join(' | ');
      }
    }

    return null;
  }
}
