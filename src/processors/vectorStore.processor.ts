import OpenAI from 'openai';
import { VectorStoreOperation, QueueResult, KnowledgeDocument } from '../types';
import { FirestoreService } from '../services/firestore.service';
import { withRetry, isRateLimitError } from '../utils';

interface ProcessorConfig {
  concurrency: number;
  retries: number;
}

const DEFAULT_CONFIG: ProcessorConfig = {
  concurrency: 10,
  retries: 3,
};

export class VectorStoreProcessor {
  private openai: OpenAI;
  private vectorStoreId: string;
  private firestore: FirestoreService;
  private config: ProcessorConfig;

  constructor(
    apiKey: string,
    vectorStoreId: string,
    firestore: FirestoreService,
    config: Partial<ProcessorConfig> = {}
  ) {
    this.openai = new OpenAI({ apiKey });
    this.vectorStoreId = vectorStoreId;
    this.firestore = firestore;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Process a batch of operations in parallel
   * Returns results as they complete (does not wait for all)
   */
  async processQueue(operations: VectorStoreOperation[]): Promise<QueueResult[]> {
    const results: QueueResult[] = [];
    const chunks = this.chunkArray(operations, this.config.concurrency);

    console.log(`Processing ${operations.length} operations with concurrency ${this.config.concurrency}`);

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map(op => this.processOperation(op))
      );
      results.push(...chunkResults);

      // Log progress
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      console.log(`Progress: ${results.length}/${operations.length} (${successful} ok, ${failed} failed)`);
    }

    return results;
  }

  /**
   * Process a single operation with retries
   */
  private async processOperation(operation: VectorStoreOperation): Promise<QueueResult> {
    try {
      if (operation.type === 'upload') {
        const fileId = await this.uploadFile(operation.content, operation.filename);

        // Update Firestore with the file ID
        await this.firestore.updateDocumentFileId(
          operation.source,
          operation.id,
          fileId
        );

        return { operation, success: true, fileId };
      } else {
        await this.deleteFile(operation.fileId);

        // Remove from Firestore
        await this.firestore.deleteDocument(operation.docId);

        return { operation, success: true };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Operation failed: ${operation.type} - ${errorMsg}`);
      return { operation, success: false, error: errorMsg };
    }
  }

  /**
   * Upload a file to OpenAI and add to vector store
   * Does NOT wait for processing - fire and forget
   */
  private async uploadFile(content: string, filename: string): Promise<string> {
    return withRetry(
      async () => {
        // Create file
        const file = await this.openai.files.create({
          file: new File([content], filename, { type: 'text/plain' }),
          purpose: 'assistants',
        });

        // Add to vector store (don't wait for processing)
        await this.openai.vectorStores.files.create(
          this.vectorStoreId,
          { file_id: file.id }
        );

        console.log(`Uploaded: ${filename} -> ${file.id}`);
        return file.id;
      },
      {
        maxRetries: this.config.retries,
        initialDelayMs: 1000,
        retryOn: isRateLimitError,
      }
    );
  }

  /**
   * Delete a file from vector store and OpenAI
   */
  private async deleteFile(fileId: string): Promise<void> {
    return withRetry(
      async () => {
        try {
          // Remove from vector store first
          await this.openai.vectorStores.files.del(this.vectorStoreId, fileId);
        } catch (error) {
          // File might not be in vector store, continue
          console.log(`Could not remove from vector store: ${fileId}`);
        }

        // Delete the file itself
        try {
          await this.openai.files.del(fileId);
          console.log(`Deleted: ${fileId}`);
        } catch (error: unknown) {
          // Handle 404 - file already deleted (OK to ignore)
          const apiError = error as { status?: number };
          if (apiError.status === 404) {
            console.log(`File already deleted from OpenAI: ${fileId}`);
          } else {
            throw error;  // Re-throw other errors
          }
        }
      },
      {
        maxRetries: this.config.retries,
        initialDelayMs: 1000,
        retryOn: isRateLimitError,
      }
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC SINGLE FILE METHODS (for streaming sync)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Upload a single file to OpenAI vector store
   */
  async uploadSingleFile(content: string, filename: string): Promise<string> {
    return this.uploadFile(content, filename);
  }

  /**
   * Delete a single file from OpenAI vector store
   */
  async deleteSingleFile(fileId: string): Promise<void> {
    return this.deleteFile(fileId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTENT FORMATTERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Format content for Notion pages
   */
  static formatNotionContent(params: {
    url: string;
    title: string;
    content: string;
  }): string {
    return `[SOURCE:notion|URL:${params.url}|TITLE:${params.title}]

${params.content}`;
  }

  /**
   * Format content for Slack messages
   */
  static formatSlackContent(params: {
    url: string;
    channelName: string;
    authorName: string;
    timestamp: string;
    content: string;
    threadReplies?: Array<{ authorName: string; text: string }>;
  }): string {
    let formatted = `[SOURCE:slack|URL:${params.url}|TITLE:Slack message in #${params.channelName}]

Author: ${params.authorName}
Channel: #${params.channelName}
Time: ${params.timestamp}

${params.content}`;

    if (params.threadReplies && params.threadReplies.length > 0) {
      formatted += '\n\n--- Thread Replies ---';
      for (const reply of params.threadReplies) {
        formatted += `\n${reply.authorName}: ${reply.text}`;
      }
    }

    return formatted;
  }

  /**
   * Split array into chunks for parallel processing
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}
