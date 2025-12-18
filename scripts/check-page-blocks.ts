/**
 * Check how many blocks and API calls a specific page requires
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// Marketing page ID from the sync
const PAGE_ID = '11097c19-b41f-80a5-889f-e1df2a26c328';

async function countBlocks(blockId: string, depth = 0): Promise<{ blocks: number; apiCalls: number; maxDepth: number }> {
  let blocks = 0;
  let apiCalls = 0;
  let maxDepth = depth;
  let hasMore = true;
  let cursor: string | undefined;

  while (hasMore) {
    apiCalls++;
    const response = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    });

    blocks += response.results.length;
    
    // Count nested blocks
    for (const block of response.results) {
      if ((block as any).has_children) {
        const nested = await countBlocks((block as any).id, depth + 1);
        blocks += nested.blocks;
        apiCalls += nested.apiCalls;
        maxDepth = Math.max(maxDepth, nested.maxDepth);
      }
    }

    hasMore = response.has_more;
    cursor = response.next_cursor || undefined;

    // Progress indicator
    if (depth === 0) {
      process.stdout.write(`\r  Counted ${blocks} blocks, ${apiCalls} API calls, depth ${maxDepth}...`);
    }
  }

  return { blocks, apiCalls, maxDepth };
}

async function main() {
  console.log('=== Checking "Marketing" page blocks ===\n');
  
  // First get the page title
  const page = await notion.pages.retrieve({ page_id: PAGE_ID }) as any;
  const title = page.properties?.title?.title?.[0]?.plain_text || 'Unknown';
  console.log(`Page: "${title}"\n`);
  
  console.log('Counting blocks (this may take a while)...');
  const start = Date.now();
  const result = await countBlocks(PAGE_ID);
  const duration = Date.now() - start;
  
  console.log(`\n\n=== Results ===`);
  console.log(`Total blocks:     ${result.blocks}`);
  console.log(`API calls needed: ${result.apiCalls}`);
  console.log(`Max nesting depth: ${result.maxDepth}`);
  console.log(`Time to fetch:    ${(duration / 1000).toFixed(1)}s`);
  console.log(`\nWith rate limit (3 req/sec): ~${Math.ceil(result.apiCalls / 3)}s minimum`);
}

main().catch(console.error);

