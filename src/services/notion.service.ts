import { Client } from '@notionhq/client';
import { 
  PageObjectResponse, 
  BlockObjectResponse,
  RichTextItemResponse,
  PartialBlockObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';
import { NotionPage, SyncResult, KnowledgeDocument } from '../types';
import { FirestoreService } from './firestore.service';
import { VectorStoreService } from './vectorStore.service';
import { RateLimiter, calculateContentHash, withRetry, isRateLimitError } from '../utils';

export class NotionService {
  private notion: Client;
  private firestore: FirestoreService;
  private vectorStore: VectorStoreService;
  private rateLimiter: RateLimiter;

  constructor(
    notionApiKey: string,
    openaiApiKey: string,
    vectorStoreId: string
  ) {
    this.notion = new Client({ auth: notionApiKey });
    this.firestore = new FirestoreService();
    this.vectorStore = new VectorStoreService(openaiApiKey, vectorStoreId);
    // Notion rate limit: 3 requests per second
    this.rateLimiter = new RateLimiter(1, 350);
  }

  /**
   * Run the full Notion sync process - streams pages and uploads as it goes
   */
  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      source: 'notion',
      added: 0,
      updated: 0,
      skipped: 0,
      errored: 0,
      errors: [],
    };

    console.log('Starting Notion sync...');
    
    try {
      await this.firestore.startSync('notion');

      // Get last sync timestamp
      const syncState = await this.firestore.getSyncState('notion');
      const lastSyncTimestamp = syncState?.lastSyncTimestamp || null;
      
      console.log(`Last sync timestamp: ${lastSyncTimestamp || 'none (first sync)'}`);

      let latestTimestamp = lastSyncTimestamp;
      let pagesProcessed = 0;
      let totalPagesFound = 0;
      let batchNumber = 0;
      let hasMore = true;
      let startCursor: string | undefined;

      // Stream pages and process them immediately (don't wait to fetch all)
      while (hasMore) {
        batchNumber++;
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

        totalPagesFound += response.results.length;
        console.log(`Batch ${batchNumber}: fetched ${response.results.length} pages (total found so far: ${totalPagesFound}, has_more: ${response.has_more})`);

        for (const pageResult of response.results) {
          if (pageResult.object !== 'page') continue;
          
          const page = pageResult as PageObjectResponse;
          const lastEditedTime = page.last_edited_time;

          // If we have a timestamp and this page hasn't been modified since, we can stop
          if (lastSyncTimestamp && lastEditedTime <= lastSyncTimestamp) {
            hasMore = false;
            break;
          }

          // Extract page info
          const notionPage = await this.extractPageInfo(page);
          
          if (notionPage) {
            // Process immediately (upload to vector store)
            try {
              const processResult = await this.processPage(notionPage);
              
              if (processResult === 'added') result.added++;
              else if (processResult === 'updated') result.updated++;
              else if (processResult === 'skipped') result.skipped++;

              // Track the latest edited time
              if (!latestTimestamp || notionPage.lastEditedTime > latestTimestamp) {
                latestTimestamp = notionPage.lastEditedTime;
              }
              
              pagesProcessed++;
              
              // Log progress every 10 pages
              if (pagesProcessed % 10 === 0) {
                console.log(`Progress: ${pagesProcessed} pages processed, ${result.added} added, ${result.updated} updated`);
              }
            } catch (error) {
              result.errored++;
              const errorMsg = `Error processing page ${notionPage.id}: ${error}`;
              result.errors.push(errorMsg);
              console.error(errorMsg);
            }
          } else {
            result.skipped++;
          }
        }

        hasMore = hasMore && response.has_more;
        startCursor = response.next_cursor || undefined;
        
        // Safety: save state periodically to handle timeouts
        if (pagesProcessed > 0 && pagesProcessed % 50 === 0) {
          const currentTotal = await this.firestore.getDocumentCount('notion');
          await this.firestore.updateSyncState('notion', {
            totalDocuments: currentTotal,
            lastSyncTimestamp: latestTimestamp,
          });
          console.log(`Checkpoint: saved state at ${pagesProcessed} pages`);
        }
      }

      // Update sync state
      const totalDocs = await this.firestore.getDocumentCount('notion');
      await this.firestore.completeSync(
        'notion',
        latestTimestamp || new Date().toISOString(),
        totalDocs
      );

      console.log(`Notion sync completed: totalPagesFound=${totalPagesFound}, processed=${pagesProcessed}, added=${result.added}, updated=${result.updated}, skipped=${result.skipped}, errored=${result.errored}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.firestore.failSync('notion', errorMsg);
      throw error;
    }

    return result;
  }

  /**
   * Fetch all pages from Notion
   */
  private async fetchAllPages(sinceTimestamp: string | null): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let hasMore = true;
    let startCursor: string | undefined;

    while (hasMore) {
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
        const lastEditedTime = page.last_edited_time;

        // If we have a timestamp and this page hasn't been modified since, we can stop
        // (results are sorted by last_edited_time descending)
        if (sinceTimestamp && lastEditedTime <= sinceTimestamp) {
          hasMore = false;
          break;
        }

        const notionPage = await this.extractPageInfo(page);
        if (notionPage) {
          pages.push(notionPage);
        }
      }

      hasMore = hasMore && response.has_more;
      startCursor = response.next_cursor || undefined;
    }

    return pages;
  }

  /**
   * Extract page information including content
   */
  private async extractPageInfo(page: PageObjectResponse): Promise<NotionPage | null> {
    try {
      // Get page title
      const title = this.getPageTitle(page);
      
      // Get page block content
      const blockContent = await this.getPageContent(page.id);
      
      // Get property content (for database items)
      const propertyContent = this.extractPropertyContent(page);
      
      // Debug logging
      console.log(`Page ${page.id}: title="${title}", blocks=${blockContent.length}chars, props=${propertyContent.length}chars`);
      
      // Combine both - prefer blocks, fall back to properties
      let content = blockContent;
      if (!content.trim() && propertyContent.trim()) {
        content = propertyContent;
      } else if (content.trim() && propertyContent.trim()) {
        // If both exist, combine them
        content = `${propertyContent}\n\n---\n\n${content}`;
      }
      
      // Include page if it has title (even with minimal content)
      // At minimum, we want the title synced
      if (!content.trim()) {
        if (title && title !== 'Untitled') {
          // Use title as content for pages with no other content
          content = `Title: ${title}`;
          console.log(`Using title as content for page: ${title} (${page.id})`);
        } else {
          console.log(`Skipping empty page: ${page.id}`);
          return null;
        }
      }

      return {
        id: page.id,
        title: title || 'Untitled',
        url: page.url,
        lastEditedTime: page.last_edited_time,
        content,
      };
    } catch (error) {
      console.error(`Error extracting page info for ${page.id}:`, error);
      return null;
    }
  }

  /**
   * Extract content from page properties (for database items)
   */
  private extractPropertyContent(page: PageObjectResponse): string {
    const parts: string[] = [];
    const properties = page.properties;

    for (const [key, prop] of Object.entries(properties)) {
      const value = this.extractPropertyValue(prop);
      if (value && value.trim()) {
        // Skip the title property as it's already used as the page title
        if (prop.type !== 'title') {
          parts.push(`${key}: ${value}`);
        }
      }
    }

    return parts.join('\n');
  }

  /**
   * Extract value from a property
   */
  private extractPropertyValue(prop: PageObjectResponse['properties'][string]): string {
    switch (prop.type) {
      case 'title':
        return prop.title.map(t => t.plain_text).join('');
      
      case 'rich_text':
        return prop.rich_text.map(t => t.plain_text).join('');
      
      case 'number':
        return prop.number?.toString() || '';
      
      case 'select':
        return prop.select?.name || '';
      
      case 'multi_select':
        return prop.multi_select.map(s => s.name).join(', ');
      
      case 'date':
        if (!prop.date) return '';
        const start = prop.date.start || '';
        const end = prop.date.end ? ` to ${prop.date.end}` : '';
        return `${start}${end}`;
      
      case 'checkbox':
        return prop.checkbox ? 'Yes' : 'No';
      
      case 'url':
        return prop.url || '';
      
      case 'email':
        return prop.email || '';
      
      case 'phone_number':
        return prop.phone_number || '';
      
      case 'status':
        return prop.status?.name || '';
      
      case 'people':
        return prop.people.map((p) => ('name' in p ? p.name : 'Unknown') || 'Unknown').join(', ');
      
      case 'files':
        return prop.files.map((f) => ('name' in f ? f.name : 'File') || 'File').join(', ');
      
      case 'relation':
        return `[${prop.relation.length} related items]`;
      
      case 'rollup':
        if (prop.rollup.type === 'number') {
          return prop.rollup.number?.toString() || '';
        }
        return '';
      
      case 'formula':
        if (prop.formula.type === 'string') return prop.formula.string || '';
        if (prop.formula.type === 'number') return prop.formula.number?.toString() || '';
        if (prop.formula.type === 'boolean') return prop.formula.boolean ? 'Yes' : 'No';
        if (prop.formula.type === 'date') return prop.formula.date?.start || '';
        return '';
      
      default:
        return '';
    }
  }

  /**
   * Get page title from properties
   */
  private getPageTitle(page: PageObjectResponse): string {
    const properties = page.properties;
    
    // Try common title property names
    for (const key of ['title', 'Title', 'Name', 'name']) {
      const prop = properties[key];
      if (prop && prop.type === 'title' && prop.title.length > 0) {
        return prop.title.map(t => t.plain_text).join('');
      }
    }

    // Search all properties for a title type
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

    return textParts.join('\n\n');
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
          
          // Recursively get children if block has children
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

  /**
   * Type guard for full block objects
   */
  private isFullBlock(block: BlockObjectResponse | PartialBlockObjectResponse): block is BlockObjectResponse {
    return 'type' in block;
  }

  /**
   * Extract text from a block
   */
  private extractBlockText(block: BlockObjectResponse): string | null {
    const type = block.type;
    
    // Block types with rich_text
    const richTextBlocks = [
      'paragraph', 'heading_1', 'heading_2', 'heading_3',
      'bulleted_list_item', 'numbered_list_item', 'to_do',
      'toggle', 'quote', 'callout', 'code',
    ];

    if (richTextBlocks.includes(type)) {
      const blockData = block[type as keyof typeof block] as { rich_text?: RichTextItemResponse[] };
      if (blockData && 'rich_text' in blockData && blockData.rich_text) {
        const text = blockData.rich_text.map(rt => rt.plain_text).join('');
        
        // Add prefix for headings
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

    // Table cells
    if (type === 'table_row') {
      const cells = (block.table_row as { cells?: RichTextItemResponse[][] }).cells;
      if (cells) {
        return cells.map(cell => cell.map(rt => rt.plain_text).join('')).join(' | ');
      }
    }

    return null;
  }

  /**
   * Process a single page
   */
  private async processPage(page: NotionPage): Promise<'added' | 'updated' | 'skipped'> {
    const contentHash = calculateContentHash(page.content);
    
    // Check if document exists
    const existingDoc = await this.firestore.getDocument('notion', page.id);
    
    if (existingDoc) {
      // Check if content has changed
      if (existingDoc.contentHash === contentHash) {
        console.log(`Skipping unchanged page: ${page.title} (${page.id})`);
        return 'skipped';
      }
      
      // Content changed - update
      console.log(`Updating page: ${page.title} (${page.id})`);
      
      const formattedContent = this.vectorStore.formatNotionContent({
        url: page.url,
        title: page.title,
        content: page.content,
      });
      
      const newFileId = await this.vectorStore.updateFile(
        existingDoc.vectorStoreFileId,
        formattedContent,
        `notion_${page.id}.txt`
      );
      
      const updatedDoc: KnowledgeDocument = {
        ...existingDoc,
        vectorStoreFileId: newFileId,
        title: page.title,
        url: page.url,
        lastModified: page.lastEditedTime,
        contentHash,
        updatedAt: new Date().toISOString(),
      };
      
      await this.firestore.saveDocument(updatedDoc);
      return 'updated';
    }
    
    // New document - add
    console.log(`Adding new page: ${page.title} (${page.id})`);
    
    const formattedContent = this.vectorStore.formatNotionContent({
      url: page.url,
      title: page.title,
      content: page.content,
    });
    
    const fileId = await this.vectorStore.uploadFile(
      formattedContent,
      `notion_${page.id}.txt`
    );
    
    const newDoc: KnowledgeDocument = {
      sourceType: 'notion',
      sourceId: page.id,
      vectorStoreFileId: fileId,
      title: page.title,
      url: page.url,
      lastModified: page.lastEditedTime,
      contentHash,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    await this.firestore.saveDocument(newDoc);
    return 'added';
  }
}


