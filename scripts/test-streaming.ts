/**
 * Test the streaming Notion sync with a limit of 5 pages
 * 
 * Usage: npx ts-node scripts/test-streaming.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { NotionSync } from '../src/sync/notion.sync';

async function main() {
  console.log('=== Testing Streaming Notion Sync (5 pages) ===\n');

  // Check env vars
  const notionApiKey = process.env.NOTION_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;

  if (!notionApiKey || !openaiApiKey || !vectorStoreId) {
    console.error('❌ Missing environment variables');
    console.log('\nMake sure you have a .env file with:');
    console.log('  NOTION_API_KEY=...');
    console.log('  OPENAI_API_KEY=...');
    console.log('  OPENAI_VECTOR_STORE_ID=...');
    process.exit(1);
  }

  console.log('✅ Environment variables loaded\n');

  // Create sync instance
  const notionSync = new NotionSync(notionApiKey, openaiApiKey, vectorStoreId);

  // Run sync with limit
  console.log('Starting sync with maxPages=5...\n');

  try {
    const result = await notionSync.sync({ maxPages: 30 });

    console.log('\n=== Results ===');
    console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`Added: ${result.processed.added}`);
    console.log(`Updated: ${result.processed.updated}`);
    console.log(`Deleted: ${result.processed.deleted}`);
    console.log(`Errored: ${result.processed.errored}`);

    if (result.errors.length > 0) {
      console.log('\nErrors/Warnings:');
      result.errors.forEach(e => console.log(`  - ${e}`));
    }

    console.log('\n🎉 Test completed successfully!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

main();
