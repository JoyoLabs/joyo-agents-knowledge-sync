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
 * Smart rate limiter - only delays when actually needed
 * Tracks request timestamps and only waits if we're going too fast
 */
export class RateLimiter {
  private requestTimes: number[] = [];
  
  constructor(
    private readonly maxRequests: number,    // e.g., 3
    private readonly windowMs: number         // e.g., 1000 (1 second)
  ) {}
  
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.waitIfNeeded();
    this.requestTimes.push(Date.now());
    return fn();
  }
  
  private async waitIfNeeded(): Promise<void> {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    
    // Remove old timestamps outside the window
    this.requestTimes = this.requestTimes.filter(t => t > windowStart);
    
    // If we're at the limit, wait until the oldest request exits the window
    if (this.requestTimes.length >= this.maxRequests) {
      const oldestInWindow = this.requestTimes[0];
      const waitTime = oldestInWindow + this.windowMs - now + 10; // +10ms buffer
      if (waitTime > 0) {
        await sleep(waitTime);
      }
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



