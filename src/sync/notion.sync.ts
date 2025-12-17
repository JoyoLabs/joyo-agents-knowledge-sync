import { Client } from '@notionhq/client';
import {
  PageObjectResponse,
  BlockObjectResponse,
  RichTextItemResponse,
  PartialBlockObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';
import {
  NotionPageMeta,
  NotionPage,
  SyncDiff,
  SyncResult,
  VectorStoreOperation,
  KnowledgeDocument,
} from '../types';
import { FirestoreService } from '../services/firestore.service';
import { VectorStoreProcessor } from '../processors/vectorStore.processor';
import { RateLimiter, calculateContentHash, withRetry, isRateLimitError } from '../utils';

export class NotionSync {
  private notion: Client;
  private firestore: FirestoreService;
  private processor: VectorStoreProcessor;
  private rateLimiter: RateLimiter;

  constructor(
    notionApiKey: string,
    openaiApiKey: string,
    vectorStoreId: string
  ) {
    this.notion = new Client({ auth: notionApiKey });
    this.firestore = new FirestoreService();
    this.processor = new VectorStoreProcessor(openaiApiKey, vectorStoreId, this.firestore);
    // Notion rate limit: 3 requests per second
    this.rateLimiter = new RateLimiter(3, 350);
  }

  /**
   * Main sync entry point
   */
  async sync(): Promise<SyncResult> {
    const startTime = Date.now();
    const result: SyncResult = {
      source: 'notion',
      discovered: { total: 0, toAdd: 0, toUpdate: 0, toDelete: 0, unchanged: 0 },
      processed: { added: 0, updated: 0, deleted: 0, errored: 0 },
      errors: [],
      durationMs: 0,
    };

    console.log('=== Notion Sync Started ===');

    try {
      await this.firestore.startSync('notion');

      // Phase 1: Discover all pages from Notion
      console.log('\n[Phase 1] Discovering pages from Notion...');
      const allPages = await this.discoverAllPages();
      console.log(`Discovered ${allPages.length} pages from Notion`);

      // Phase 2: Diff against Firestore
      console.log('\n[Phase 2] Computing diff against Firestore...');
      const diff = await this.computeDiff(allPages);
      result.discovered = {
        total: allPages.length,
        toAdd: diff.toAdd.length,
        toUpdate: diff.toUpdate.length,
        toDelete: diff.toDelete.length,
        unchanged: diff.unchanged,
      };
      console.log(`Diff: +${diff.toAdd.length} add, ~${diff.toUpdate.length} update, -${diff.toDelete.length} delete, =${diff.unchanged} unchanged`);

      // Phase 3: Fetch content for changed pages
      console.log('\n[Phase 3] Fetching content for changed pages...');
      const pagesToProcess = [...diff.toAdd, ...diff.toUpdate];
      const pagesWithContent = await this.fetchContentForPages(pagesToProcess);
      console.log(`Fetched content for ${pagesWithContent.length} pages`);

      // Phase 4: Build and process queue
      console.log('\n[Phase 4] Processing vector store operations...');
      const operations = await this.buildOperations(pagesWithContent, diff);
      console.log(`Queued ${operations.length} operations`);

      if (operations.length > 0) {
        const queueResults = await this.processor.processQueue(operations);

        // Tally results
        for (const qr of queueResults) {
          if (qr.success) {
            if (qr.operation.type === 'delete') {
              result.processed.deleted++;
            } else {
              // It's an upload operation
              const op = qr.operation as { type: 'upload'; id: string };
              const isNew = diff.toAdd.some(p => p.id === op.id);
              if (isNew) {
                result.processed.added++;
              } else {
                result.processed.updated++;
              }
            }
          } else {
            result.processed.errored++;
            result.errors.push(qr.error || 'Unknown error');
          }
        }
      }

      // Update sync state
      const latestTimestamp = allPages.length > 0
        ? allPages.reduce((max, p) => p.lastEditedTime > max ? p.lastEditedTime : max, allPages[0].lastEditedTime)
        : new Date().toISOString();

      const totalDocs = await this.firestore.getDocumentCount('notion');
      await this.firestore.completeSync('notion', latestTimestamp, totalDocs);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMsg);
      await this.firestore.failSync('notion', errorMsg);
      console.error('Notion sync failed:', error);
    }

    result.durationMs = Date.now() - startTime;
    console.log(`\n=== Notion Sync Completed in ${(result.durationMs / 1000).toFixed(1)}s ===`);
    console.log(`Results: +${result.processed.added} -${result.processed.deleted} ~${result.processed.updated} !${result.processed.errored}`);

    return result;
  }

  /**
   * Phase 1: Discover all page metadata from Notion (fast)
   * Only includes workspace and page_id parents (actual pages, not database rows)
   */
  private async discoverAllPages(): Promise<NotionPageMeta[]> {
    const pages: NotionPageMeta[] = [];
    let hasMore = true;
    let startCursor: string | undefined;
    let batchNum = 0;
    let skippedDbRows = 0;

    while (hasMore) {
      batchNum++;
      const response = await this.rateLimiter.execute(() =>
        withRetry(
          () => this.notion.search({
            filter: { property: 'object', value: 'page' },
            sort: { direction: 'descending', timestamp: 'last_edited_time' },
            page_size: 100,
            start_cursor: startCursor,
          }),
          { maxRetries: 3, retryOn: isRateLimitError }
        )
      );

      for (const result of response.results) {
        if (result.object !== 'page') continue;
        const page = result as PageObjectResponse;

        // Only include actual pages, not database rows
        // - workspace: top-level pages
        // - page_id: nested pages under other pages
        // - block_id: inline pages embedded in blocks
        // Exclude:
        // - database_id: rows in databases (often automated entries, may contain sensitive data)
        const parentType = page.parent.type;
        if (parentType === 'database_id') {
          skippedDbRows++;
          continue;
        }

        pages.push({
          id: page.id,
          title: this.getPageTitle(page),
          url: page.url,
          lastEditedTime: page.last_edited_time,
        });
      }

      console.log(`  Batch ${batchNum}: ${response.results.length} results, ${pages.length} pages kept, ${skippedDbRows} db rows skipped`);
      hasMore = response.has_more;
      startCursor = response.next_cursor || undefined;
    }

    console.log(`  Total: ${pages.length} pages (skipped ${skippedDbRows} database rows)`);
    return pages;
  }

  /**
   * Phase 2: Compute diff between Notion pages and Firestore
   */
  private async computeDiff(notionPages: NotionPageMeta[]): Promise<SyncDiff<NotionPageMeta>> {
    const firestoreDocs = await this.firestore.getDocumentIdMap('notion');
    const notionIds = new Set(notionPages.map(p => p.id));

    const toAdd: NotionPageMeta[] = [];
    const toUpdate: NotionPageMeta[] = [];
    let unchanged = 0;

    for (const page of notionPages) {
      const existing = firestoreDocs.get(page.id);
      if (!existing) {
        toAdd.push(page);
      } else if (page.lastEditedTime > existing.lastModified) {
        toUpdate.push(page);
      } else {
        unchanged++;
      }
    }

    // Find deleted pages (in Firestore but not in Notion)
    const toDelete: string[] = [];
    for (const [sourceId, doc] of firestoreDocs) {
      if (!notionIds.has(sourceId)) {
        toDelete.push(doc.vectorStoreFileId);
      }
    }

    return { toAdd, toUpdate, toDelete, unchanged };
  }

  /**
   * Phase 3: Fetch content for pages that need processing
   * Uses concurrent fetching to maximize throughput within rate limits
   */
  private async fetchContentForPages(pages: NotionPageMeta[]): Promise<NotionPage[]> {
    const pagesWithContent: NotionPage[] = [];
    const concurrency = 3; // Match Notion's rate limit
    let completed = 0;

    // Process pages with controlled concurrency
    const fetchPage = async (page: NotionPageMeta): Promise<NotionPage> => {
      try {
        const content = await this.getPageContent(page.id);
        return { ...page, content };
      } catch (error) {
        console.error(`  Failed to fetch content for ${page.id}: ${error}`);
        return { ...page, content: `Title: ${page.title}` };
      }
    };

    // Process in concurrent batches
    for (let i = 0; i < pages.length; i += concurrency) {
      const batch = pages.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(fetchPage));
      pagesWithContent.push(...results);

      completed += batch.length;
      if (completed % 10 === 0 || completed === pages.length) {
        console.log(`  Fetched content: ${completed}/${pages.length}`);
      }
    }

    return pagesWithContent;
  }

  /**
   * Phase 4: Build vector store operations
   */
  private async buildOperations(
    pages: NotionPage[],
    diff: SyncDiff<NotionPageMeta>
  ): Promise<VectorStoreOperation[]> {
    const operations: VectorStoreOperation[] = [];
    const firestoreDocs = await this.firestore.getDocumentIdMap('notion');

    // Delete operations for removed pages
    for (const [sourceId, doc] of firestoreDocs) {
      if (diff.toDelete.includes(doc.vectorStoreFileId)) {
        operations.push({
          type: 'delete',
          fileId: doc.vectorStoreFileId,
          docId: this.firestore.getDocumentId('notion', sourceId),
        });
      }
    }

    // Upload operations for new/updated pages
    for (const page of pages) {
      const contentHash = calculateContentHash(page.content);
      const existing = firestoreDocs.get(page.id);

      // For updates, check if content actually changed
      if (existing && existing.contentHash === contentHash) {
        continue; // Content hasn't changed, skip
      }

      const formattedContent = VectorStoreProcessor.formatNotionContent({
        url: page.url,
        title: page.title,
        content: page.content,
      });

      // If updating, delete old file first
      if (existing) {
        operations.push({
          type: 'delete',
          fileId: existing.vectorStoreFileId,
          docId: this.firestore.getDocumentId('notion', page.id),
        });
      }

      // Create new document in Firestore first (without fileId)
      const newDoc: KnowledgeDocument = {
        sourceType: 'notion',
        sourceId: page.id,
        vectorStoreFileId: '', // Will be updated after upload
        title: page.title,
        url: page.url,
        lastModified: page.lastEditedTime,
        contentHash,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await this.firestore.saveDocument(newDoc);

      operations.push({
        type: 'upload',
        id: page.id,
        content: formattedContent,
        filename: `notion_${page.id}.txt`,
        source: 'notion',
      });
    }

    return operations;
  }

  /**
   * Get page title from properties
   */
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

  /**
   * Get all content from a page's blocks
   */
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

  /**
   * Fetch all blocks from a page (handles pagination)
   */
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
