/**
 * Detailed timing test for the full sync pipeline
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Client } from '@notionhq/client';
import OpenAI from 'openai';
import { Firestore } from '@google-cloud/firestore';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID!;
const firestore = new Firestore();

interface Timing {
  step: string;
  duration: number;
}

const timings: Timing[] = [];

async function time<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const result = await fn();
  const duration = Date.now() - start;
  timings.push({ step: name, duration });
  return result;
}

async function processOnePage(pageId: string, title: string) {
  console.log(`\n📄 Processing: "${title}"`);

  // Step 1: Fetch all blocks recursively
  let blockCount = 0;
  let apiCalls = 0;

  async function getAllBlocks(blockId: string): Promise<any[]> {
    apiCalls++;
    const response = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
    });

    let blocks = response.results;
    blockCount += blocks.length;

    for (const block of blocks) {
      if ((block as any).has_children) {
        const children = await getAllBlocks((block as any).id);
        blocks = blocks.concat(children);
      }
    }

    return blocks;
  }

  const blocks = await time(`[${title}] Notion: fetch blocks`, () => getAllBlocks(pageId));
  console.log(`  Notion blocks: ${blockCount} blocks, ${apiCalls} API calls`);

  // Step 2: Build content (fast, in memory)
  const contentStart = Date.now();
  const content = `Title: ${title}\n\nContent: ${blocks.length} blocks...`;
  timings.push({ step: `[${title}] Build content`, duration: Date.now() - contentStart });

  // Step 3: Upload to OpenAI
  const file = await time(`[${title}] OpenAI: create file`, () =>
    openai.files.create({
      file: new File([content], `test-${pageId}.txt`, { type: 'text/plain' }),
      purpose: 'assistants',
    })
  );

  // Step 4: Add to vector store
  await time(`[${title}] OpenAI: add to vector store`, () =>
    openai.vectorStores.files.create(vectorStoreId, { file_id: file.id })
  );

  // Step 5: Firestore write
  await time(`[${title}] Firestore: save document`, () =>
    firestore.collection('knowledge_documents').doc(`notion_${pageId}`).set({
      sourceType: 'notion',
      sourceId: pageId,
      vectorStoreFileId: file.id,
      title: title,
      updatedAt: new Date().toISOString(),
    }, { merge: true })
  );

  // Cleanup
  try {
    await openai.vectorStores.files.del(vectorStoreId, file.id);
    await openai.files.del(file.id);
  } catch (e) { }
}

async function main() {
  console.log('=== Detailed Timing Test (3 pages) ===\n');

  // Fetch 5 pages
  const totalStart = Date.now();

  const searchResult = await time('Notion: search pages', () =>
    notion.search({
      filter: { property: 'object', value: 'page' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 10,
    })
  );

  // Filter to actual pages (not database rows) and take 3
  const pages = searchResult.results
    .filter((p: any) => p.parent?.type !== 'database_id')
    .slice(0, 3);

  console.log(`Found ${pages.length} pages to process\n`);

  // Process each page
  for (const page of pages) {
    const title = (page as any).properties?.title?.title?.[0]?.plain_text || 'Untitled';
    await processOnePage(page.id, title);
  }

  // Summary
  console.log('\n\n=== TIMING SUMMARY ===\n');

  // Group by category
  const notionTimes = timings.filter(t => t.step.includes('Notion'));
  const openaiFileTimes = timings.filter(t => t.step.includes('OpenAI: create'));
  const openaiVectorTimes = timings.filter(t => t.step.includes('OpenAI: add'));
  const firestoreTimes = timings.filter(t => t.step.includes('Firestore'));

  const sum = (arr: Timing[]) => arr.reduce((a, b) => a + b.duration, 0);
  const avg = (arr: Timing[]) => arr.length ? Math.round(sum(arr) / arr.length) : 0;

  console.log('Category Breakdown:');
  console.log(`  Notion API:           ${sum(notionTimes)}ms total, ${avg(notionTimes)}ms avg`);
  console.log(`  OpenAI file upload:   ${sum(openaiFileTimes)}ms total, ${avg(openaiFileTimes)}ms avg`);
  console.log(`  OpenAI vector store:  ${sum(openaiVectorTimes)}ms total, ${avg(openaiVectorTimes)}ms avg`);
  console.log(`  Firestore:            ${sum(firestoreTimes)}ms total, ${avg(firestoreTimes)}ms avg`);

  console.log(`\n  TOTAL:                ${Date.now() - totalStart}ms`);

  console.log('\n\nAll timings:');
  timings.forEach(t => {
    console.log(`  ${t.duration.toString().padStart(5)}ms  ${t.step}`);
  });
}

main().catch(console.error);

