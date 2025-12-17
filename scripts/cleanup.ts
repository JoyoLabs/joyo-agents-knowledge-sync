import { Firestore } from '@google-cloud/firestore';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';

dotenv.config();

async function cleanup() {
  console.log('=== Cleanup Script ===\n');

  const openaiApiKey = process.env.OPENAI_API_KEY;
  const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;

  if (!openaiApiKey || !vectorStoreId) {
    console.error('Missing OPENAI_API_KEY or OPENAI_VECTOR_STORE_ID');
    process.exit(1);
  }

  // 1. Clear Firestore
  console.log('[1/2] Clearing Firestore collections...');
  const db = new Firestore({ projectId: 'slack-agent-hub' });

  // Delete knowledge_documents in batches
  const docsSnapshot = await db.collection('knowledge_documents').get();
  console.log(`  Found ${docsSnapshot.size} documents in knowledge_documents`);

  if (docsSnapshot.size > 0) {
    // Firestore batch limit is 500
    const batchSize = 500;
    const docs = docsSnapshot.docs;
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = db.batch();
      const chunk = docs.slice(i, i + batchSize);
      chunk.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      console.log(`  Deleted ${Math.min(i + batchSize, docs.length)}/${docs.length} documents`);
    }
  }

  // Delete knowledge_sync_state
  const stateSnapshot = await db.collection('knowledge_sync_state').get();
  console.log(`  Found ${stateSnapshot.size} documents in knowledge_sync_state`);

  if (stateSnapshot.size > 0) {
    const stateBatch = db.batch();
    stateSnapshot.docs.forEach(doc => stateBatch.delete(doc.ref));
    await stateBatch.commit();
    console.log(`  Deleted ${stateSnapshot.size} state documents`);
  }

  console.log('  Firestore cleared.\n');

  // 2. Show vector store info (user can delete from dashboard)
  console.log('[2/2] OpenAI Vector Store info...');
  const openai = new OpenAI({ apiKey: openaiApiKey });

  const store = await openai.vectorStores.retrieve(vectorStoreId);
  console.log(`  Vector Store: ${store.name} (${store.id})`);
  console.log(`  Files: ${store.file_counts.completed} completed, ${store.file_counts.in_progress} in progress`);
  console.log(`  Status: ${store.status}`);
  console.log('\n  To delete all files, delete this vector store from OpenAI dashboard');
  console.log('  and create a new one with the same ID, OR run with --delete-store flag');

  // Check for --delete-store flag
  if (process.argv.includes('--delete-store')) {
    console.log('\n  Deleting vector store...');
    await openai.vectorStores.del(vectorStoreId);
    console.log('  Vector store deleted!');
    console.log('  NOTE: You need to create a new vector store and update OPENAI_VECTOR_STORE_ID');
  }

  console.log('\n=== Cleanup Complete ===');
}

cleanup().catch(console.error);
