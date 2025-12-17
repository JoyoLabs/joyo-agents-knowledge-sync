import * as crypto from 'crypto';

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    retryOn?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    retryOn = () => true,
  } = options;

  let lastError: unknown;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt === maxRetries || !retryOn(error)) {
        throw error;
      }
      
      const delay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
      console.log(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
      await sleep(delay);
    }
  }
  
  throw lastError;
}

/**
 * Calculate MD5 hash of content for change detection
 */
export function calculateContentHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Rate limiter class for API calls
 */
export class RateLimiter {
  private queue: Array<() => void> = [];
  private running = 0;
  
  constructor(
    private readonly maxConcurrent: number,
    private readonly delayMs: number
  ) {}
  
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      await sleep(this.delayMs);
      this.release();
    }
  }
  
  private acquire(): Promise<void> {
    return new Promise(resolve => {
      if (this.running < this.maxConcurrent) {
        this.running++;
        resolve();
      } else {
        this.queue.push(() => {
          this.running++;
          resolve();
        });
      }
    });
  }
  
  private release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

/**
 * Format date for logging
 */
export function formatDate(date: Date): string {
  return date.toISOString();
}

/**
 * Parse Slack timestamp to Date
 */
export function slackTsToDate(ts: string): Date {
  const seconds = parseFloat(ts);
  return new Date(seconds * 1000);
}

/**
 * Convert Date to Slack timestamp format
 */
export function dateToSlackTs(date: Date): string {
  return (date.getTime() / 1000).toFixed(6);
}

/**
 * Truncate string for logging
 */
export function truncate(str: string, maxLength: number = 100): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

/**
 * Check if error is a rate limit error
 */
export function isRateLimitError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const err = error as { status?: number; code?: string; message?: string };
    return (
      err.status === 429 ||
      err.code === 'rate_limited' ||
      (err.message?.toLowerCase().includes('rate limit') ?? false)
    );
  }
  return false;
}



