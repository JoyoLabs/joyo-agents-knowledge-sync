/**
 * Timing test to identify bottlenecks
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Client } from '@notionhq/client';
import OpenAI from 'openai';

async function main() {
  console.log('=== Timing Test ===\n');

  const notion = new Client({ auth: process.env.NOTION_API_KEY });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID!;

  // Test 1: Notion Search API
  console.log('[Test 1] Notion Search API (fetch 5 pages metadata)...');
  let start = Date.now();
  const searchResult = await notion.search({
    filter: { property: 'object', value: 'page' },
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
    page_size: 5,
  });
  console.log(`  ✓ ${Date.now() - start}ms - Fetched ${searchResult.results.length} pages\n`);

  // Get first real page (not database row)
  const page = searchResult.results.find((p: any) => p.parent?.type !== 'database_id') as any;
  if (!page) {
    console.log('No pages found');
    return;
  }
  console.log(`  Using page: "${page.properties?.title?.title?.[0]?.plain_text || page.id}"\n`);

  // Test 2: Fetch blocks (single level)
  console.log('[Test 2] Notion Blocks API (single level)...');
  start = Date.now();
  const blocks = await notion.blocks.children.list({
    block_id: page.id,
    page_size: 100,
  });
  console.log(`  ✓ ${Date.now() - start}ms - Fetched ${blocks.results.length} blocks\n`);

  // Test 3: Count nested blocks
  const blocksWithChildren = blocks.results.filter((b: any) => b.has_children);
  console.log(`[Test 3] Blocks with children: ${blocksWithChildren.length}`);
  
  if (blocksWithChildren.length > 0) {
    console.log('  Fetching first nested block...');
    start = Date.now();
    const nested = await notion.blocks.children.list({
      block_id: (blocksWithChildren[0] as any).id,
      page_size: 100,
    });
    console.log(`  ✓ ${Date.now() - start}ms - Fetched ${nested.results.length} nested blocks\n`);
  }

  // Test 4: Full recursive fetch (with timing per level)
  console.log('[Test 4] Full recursive block fetch...');
  start = Date.now();
  let apiCalls = 0;
  
  async function getAllBlocksWithCount(blockId: string, depth = 0): Promise<number> {
    apiCalls++;
    const response = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
    });
    
    let count = response.results.length;
    
    for (const block of response.results) {
      if ((block as any).has_children) {
        count += await getAllBlocksWithCount((block as any).id, depth + 1);
      }
    }
    
    return count;
  }
  
  const totalBlocks = await getAllBlocksWithCount(page.id);
  const fetchTime = Date.now() - start;
  console.log(`  ✓ ${fetchTime}ms - ${totalBlocks} total blocks, ${apiCalls} API calls`);
  console.log(`  Average per API call: ${Math.round(fetchTime / apiCalls)}ms\n`);

  // Test 5: OpenAI file upload
  console.log('[Test 5] OpenAI file upload...');
  const testContent = 'Test content for timing measurement. '.repeat(100);
  start = Date.now();
  const file = await openai.files.create({
    file: new File([testContent], 'test-timing.txt', { type: 'text/plain' }),
    purpose: 'assistants',
  });
  console.log(`  ✓ ${Date.now() - start}ms - File created: ${file.id}\n`);

  // Test 6: Add to vector store
  console.log('[Test 6] Add to vector store...');
  start = Date.now();
  await openai.vectorStores.files.create(vectorStoreId, { file_id: file.id });
  console.log(`  ✓ ${Date.now() - start}ms - Added to vector store\n`);

  // Cleanup
  console.log('[Cleanup] Deleting test file...');
  try {
    await openai.vectorStores.files.del(vectorStoreId, file.id);
    await openai.files.del(file.id);
    console.log('  ✓ Deleted\n');
  } catch (e) {
    console.log('  ⚠️ Could not delete\n');
  }

  // Summary
  console.log('=== Summary ===');
  console.log(`Notion Search: Fast (~500ms)`);
  console.log(`Notion Blocks (recursive): ${apiCalls} API calls × ~${Math.round(fetchTime / apiCalls)}ms = ${fetchTime}ms`);
  console.log(`OpenAI Upload: ~2-3 seconds per file`);
  console.log(`\nBottleneck: Recursive block fetching (${apiCalls} API calls for 1 page)`);
}

main().catch(console.error);

