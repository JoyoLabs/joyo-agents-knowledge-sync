import OpenAI from 'openai';
import { VectorStoreFile } from '../types';
import { withRetry, sleep, isRateLimitError } from '../utils';

export class VectorStoreService {
  private openai: OpenAI;
  private vectorStoreId: string;

  constructor(apiKey: string, vectorStoreId: string) {
    this.openai = new OpenAI({ apiKey });
    this.vectorStoreId = vectorStoreId;
  }

  /**
   * Format content for vector store upload with metadata header
   */
  formatNotionContent(params: {
    url: string;
    title: string;
    content: string;
  }): string {
    return `[SOURCE:notion|URL:${params.url}|TITLE:${params.title}]

${params.content}`;
  }

  /**
   * Format Slack message for vector store upload with metadata header
   */
  formatSlackContent(params: {
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
   * Upload content to vector store
   */
  async uploadFile(content: string, filename: string): Promise<string> {
    return withRetry(
      async () => {
        // Create a file from the content
        const file = await this.openai.files.create({
          file: new File([content], filename, { type: 'text/plain' }),
          purpose: 'assistants',
        });

        console.log(`Created file: ${file.id} (${filename})`);

        // Add file to vector store
        const vectorStoreFile = await this.openai.vectorStores.files.create(
          this.vectorStoreId,
          { file_id: file.id }
        );

        console.log(`Added to vector store: ${vectorStoreFile.id}`);

        // Wait for processing to complete
        await this.waitForProcessing(file.id);

        return file.id;
      },
      {
        maxRetries: 3,
        initialDelayMs: 2000,
        retryOn: isRateLimitError,
      }
    );
  }

  /**
   * Wait for file processing to complete
   */
  private async waitForProcessing(fileId: string, maxWaitMs: number = 60000): Promise<void> {
    const startTime = Date.now();
    const pollIntervalMs = 2000;

    while (Date.now() - startTime < maxWaitMs) {
      const status = await this.getFileStatus(fileId);
      
      if (status.status === 'completed') {
        console.log(`File ${fileId} processing completed`);
        return;
      }
      
      if (status.status === 'failed' || status.status === 'cancelled') {
        throw new Error(`File processing ${status.status}: ${fileId}`);
      }

      await sleep(pollIntervalMs);
    }

    console.warn(`File ${fileId} processing timeout, continuing anyway`);
  }

  /**
   * Get file status from vector store
   */
  async getFileStatus(fileId: string): Promise<VectorStoreFile> {
    const result = await this.openai.vectorStores.files.retrieve(
      this.vectorStoreId,
      fileId
    );
    return {
      id: result.id,
      status: result.status as VectorStoreFile['status'],
    };
  }

  /**
   * Delete a file from the vector store and OpenAI
   */
  async deleteFile(fileId: string): Promise<void> {
    return withRetry(
      async () => {
        try {
          // Remove from vector store first
          await this.openai.vectorStores.files.del(this.vectorStoreId, fileId);
          console.log(`Removed from vector store: ${fileId}`);
        } catch (error) {
          // File might not be in vector store, continue to delete the file itself
          console.log(`Could not remove from vector store (may not exist): ${fileId}`);
        }

        // Delete the file itself
        await this.openai.files.del(fileId);
        console.log(`Deleted file: ${fileId}`);
      },
      {
        maxRetries: 3,
        initialDelayMs: 1000,
        retryOn: isRateLimitError,
      }
    );
  }

  /**
   * Update a file (delete old, upload new)
   */
  async updateFile(oldFileId: string, newContent: string, filename: string): Promise<string> {
    // Delete old file
    try {
      await this.deleteFile(oldFileId);
    } catch (error) {
      console.warn(`Could not delete old file ${oldFileId}:`, error);
    }

    // Upload new file
    return this.uploadFile(newContent, filename);
  }

  /**
   * Get vector store info
   */
  async getVectorStoreInfo(): Promise<{
    id: string;
    name: string;
    fileCount: number;
    status: string;
  }> {
    const store = await this.openai.vectorStores.retrieve(this.vectorStoreId);
    return {
      id: store.id,
      name: store.name,
      fileCount: store.file_counts.completed,
      status: store.status,
    };
  }
}

