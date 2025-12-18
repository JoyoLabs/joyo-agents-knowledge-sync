/**
 * FULL CLEANUP - Delete everything and start fresh
 * Uses parallel deletion for speed
 */

import * as dotenv from 'dotenv';
dotenv.config();

import OpenAI from 'openai';
import { Firestore } from '@google-cloud/firestore';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID!;
const firestore = new Firestore();

// Parallel batch helper
async function batchProcess<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency: number = 10
): Promise<{ success: number; errors: number }> {
  let success = 0;
  let errors = 0;
  
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map(fn));
    
    for (const result of results) {
      if (result.status === 'fulfilled') success++;
      else errors++;
    }
    
    process.stdout.write(`\r    Progress: ${Math.min(i + concurrency, items.length)}/${items.length}`);
  }
  console.log('');
  
  return { success, errors };
}

async function clearFirestore(): Promise<void> {
  console.log('\n🔥 Clearing Firestore...\n');
  
  // Delete all knowledge_documents
  console.log('  Deleting knowledge_documents...');
  const docs = await firestore.collection('knowledge_documents').listDocuments();
  console.log(`    Found ${docs.length} documents`);
  
  const batchSize = 500;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = firestore.batch();
    const chunk = docs.slice(i, i + batchSize);
    
    for (const doc of chunk) {
      batch.delete(doc);
    }
    
    await batch.commit();
    console.log(`    Deleted ${Math.min(i + batchSize, docs.length)}/${docs.length}`);
  }
  
  // Reset sync_states
  console.log('\n  Resetting sync_states...');
  const states = await firestore.collection('sync_states').listDocuments();
  for (const state of states) {
    await state.delete();
    console.log(`    Deleted ${state.id}`);
  }
  
  console.log('  ✅ Firestore cleared');
}

async function clearOpenAI(): Promise<void> {
  console.log('\n📁 Clearing OpenAI files (parallel)...\n');
  
  // Get all files
  console.log('  Fetching file list...');
  const allFiles: string[] = [];
  let hasMore = true;
  let after: string | undefined;
  
  while (hasMore) {
    const response = await openai.files.list({ limit: 100, after });
    
    for (const file of response.data) {
      // Only delete our sync files
      if (file.filename?.startsWith('notion_') || file.filename?.startsWith('slack_')) {
        allFiles.push(file.id);
      }
    }
    
    hasMore = response.has_more;
    if (response.data.length > 0) {
      after = response.data[response.data.length - 1].id;
    } else {
      hasMore = false;
    }
  }
  
  console.log(`  Found ${allFiles.length} sync files to delete`);
  
  if (allFiles.length === 0) {
    console.log('  ✅ No files to delete');
    return;
  }
  
  // Delete files in parallel (20 concurrent)
  console.log('  Deleting files (20 parallel)...');
  const result = await batchProcess(allFiles, async (fileId) => {
    try {
      await openai.vectorStores.files.del(vectorStoreId, fileId).catch(() => {});
    } catch (e) {}
    await openai.files.del(fileId);
  }, 20);
  
  console.log(`  ✅ Deleted ${result.success} files (${result.errors} errors)`);
}

async function clearVectorStore(): Promise<void> {
  console.log('\n📊 Clearing vector store (parallel)...\n');
  
  // Get all files in vector store
  console.log('  Fetching vector store file list...');
  const vsFiles: string[] = [];
  let hasMore = true;
  let after: string | undefined;
  
  while (hasMore) {
    const response = await openai.vectorStores.files.list(vectorStoreId, { limit: 100, after });
    
    for (const file of response.data) {
      vsFiles.push(file.id);
    }
    
    hasMore = response.has_more;
    if (response.data.length > 0) {
      after = response.data[response.data.length - 1].id;
    } else {
      hasMore = false;
    }
  }
  
  console.log(`  Found ${vsFiles.length} files in vector store`);
  
  if (vsFiles.length === 0) {
    console.log('  ✅ Vector store already empty');
    return;
  }
  
  // Remove from vector store in parallel (20 concurrent)
  console.log('  Removing files (20 parallel)...');
  const result = await batchProcess(vsFiles, async (fileId) => {
    await openai.vectorStores.files.del(vectorStoreId, fileId);
  }, 20);
  
  console.log(`  ✅ Removed ${result.success} files from vector store (${result.errors} errors)`);
}

async function main() {
  console.log('=== FULL CLEANUP (PARALLEL) ===');
  console.log('⚠️  This will delete ALL sync data!\n');
  
  const start = Date.now();
  
  await clearFirestore();
  await clearVectorStore();
  await clearOpenAI();
  
  const duration = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n\n🎉 CLEANUP COMPLETE in ${duration}s!`);
  console.log('You can now run a fresh sync.');
}

main().catch(console.error);
