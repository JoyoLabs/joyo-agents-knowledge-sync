/**
 * Cleanup OpenAI files to match Firestore state
 * 
 * This script ensures:
 * 1. Only files tracked in Firestore exist in OpenAI
 * 2. Only those files are in the vector store
 */

import * as dotenv from 'dotenv';
dotenv.config();

import OpenAI from 'openai';
import { Firestore } from '@google-cloud/firestore';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID!;
const firestore = new Firestore();

interface Stats {
  openaiFiles: number;
  vectorStoreFiles: number;
  firestoreDocuments: number;
  orphanedFilesDeleted: number;
  orphanedVectorFilesRemoved: number;
  missingFromVectorStore: number;
}

const stats: Stats = {
  openaiFiles: 0,
  vectorStoreFiles: 0,
  firestoreDocuments: 0,
  orphanedFilesDeleted: 0,
  orphanedVectorFilesRemoved: 0,
  missingFromVectorStore: 0,
};

async function getAllOpenAIFiles(): Promise<Map<string, { id: string; filename: string }>> {
  console.log('\n📁 Fetching all OpenAI files...');
  const files = new Map<string, { id: string; filename: string }>();

  let hasMore = true;
  let after: string | undefined;

  while (hasMore) {
    const response = await openai.files.list({ limit: 100, after });

    for (const file of response.data) {
      // Only track our sync files (notion_*.txt, slack_*.txt)
      if (file.filename?.startsWith('notion_') || file.filename?.startsWith('slack_')) {
        files.set(file.id, { id: file.id, filename: file.filename });
      }
    }

    hasMore = response.has_more;
    if (response.data.length > 0) {
      after = response.data[response.data.length - 1].id;
    } else {
      hasMore = false;
    }
  }

  stats.openaiFiles = files.size;
  console.log(`  Found ${files.size} sync files in OpenAI`);
  return files;
}

async function getVectorStoreFiles(): Promise<Set<string>> {
  console.log('\n📊 Fetching vector store files...');
  const fileIds = new Set<string>();

  let hasMore = true;
  let after: string | undefined;

  while (hasMore) {
    const response = await openai.vectorStores.files.list(vectorStoreId, { limit: 100, after });

    for (const file of response.data) {
      fileIds.add(file.id);
    }

    hasMore = response.has_more;
    if (response.data.length > 0) {
      after = response.data[response.data.length - 1].id;
    } else {
      hasMore = false;
    }
  }

  stats.vectorStoreFiles = fileIds.size;
  console.log(`  Found ${fileIds.size} files in vector store`);
  return fileIds;
}

async function getFirestoreDocuments(): Promise<Map<string, string>> {
  console.log('\n🔥 Fetching Firestore documents...');
  const docs = new Map<string, string>(); // vectorStoreFileId -> sourceId

  const snapshot = await firestore.collection('knowledge_documents').get();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (data.vectorStoreFileId) {
      docs.set(data.vectorStoreFileId, data.sourceId);
    }
  }

  stats.firestoreDocuments = docs.size;
  console.log(`  Found ${docs.size} documents with vectorStoreFileId in Firestore`);
  return docs;
}

async function cleanupOrphanedFiles(
  openaiFiles: Map<string, { id: string; filename: string }>,
  firestoreDocs: Map<string, string>,
  vectorStoreFiles: Set<string>
): Promise<void> {
  console.log('\n🧹 Cleaning up orphaned files...\n');

  // Find files in OpenAI that aren't in Firestore
  const orphanedFiles: string[] = [];
  for (const [fileId, file] of openaiFiles) {
    if (!firestoreDocs.has(fileId)) {
      orphanedFiles.push(fileId);
      console.log(`  ❌ Orphaned file: ${file.filename} (${fileId})`);
    }
  }

  if (orphanedFiles.length === 0) {
    console.log('  ✅ No orphaned files found');
    return;
  }

  console.log(`\n  Found ${orphanedFiles.length} orphaned files to delete`);

  // Delete orphaned files
  for (const fileId of orphanedFiles) {
    try {
      // Remove from vector store first (if present)
      if (vectorStoreFiles.has(fileId)) {
        await openai.vectorStores.files.del(vectorStoreId, fileId);
        stats.orphanedVectorFilesRemoved++;
        console.log(`    Removed from vector store: ${fileId}`);
      }

      // Delete from OpenAI
      await openai.files.del(fileId);
      stats.orphanedFilesDeleted++;
      console.log(`    Deleted file: ${fileId}`);
    } catch (error) {
      console.log(`    ⚠️ Failed to delete ${fileId}: ${error}`);
    }
  }
}

async function ensureVectorStoreComplete(
  firestoreDocs: Map<string, string>,
  vectorStoreFiles: Set<string>
): Promise<void> {
  console.log('\n📥 Ensuring all Firestore files are in vector store...\n');

  const missing: string[] = [];
  for (const fileId of firestoreDocs.keys()) {
    if (!vectorStoreFiles.has(fileId)) {
      missing.push(fileId);
    }
  }

  if (missing.length === 0) {
    console.log('  ✅ All Firestore files are in vector store');
    return;
  }

  console.log(`  Found ${missing.length} files missing from vector store`);
  stats.missingFromVectorStore = missing.length;

  // Add missing files to vector store
  for (const fileId of missing) {
    try {
      await openai.vectorStores.files.create(vectorStoreId, { file_id: fileId });
      console.log(`    Added to vector store: ${fileId}`);
    } catch (error: any) {
      // File might not exist anymore
      console.log(`    ⚠️ Failed to add ${fileId}: ${error.message || error}`);
    }
  }
}

async function main() {
  console.log('=== OpenAI Cleanup Script ===');
  console.log(`Vector Store: ${vectorStoreId}\n`);

  // Gather data
  const openaiFiles = await getAllOpenAIFiles();
  const vectorStoreFiles = await getVectorStoreFiles();
  const firestoreDocs = await getFirestoreDocuments();

  // Cleanup
  await cleanupOrphanedFiles(openaiFiles, firestoreDocs, vectorStoreFiles);
  await ensureVectorStoreComplete(firestoreDocs, vectorStoreFiles);

  // Summary
  console.log('\n\n=== Summary ===');
  console.log(`OpenAI files (sync):       ${stats.openaiFiles}`);
  console.log(`Vector store files:        ${stats.vectorStoreFiles}`);
  console.log(`Firestore documents:       ${stats.firestoreDocuments}`);
  console.log(`Orphaned files deleted:    ${stats.orphanedFilesDeleted}`);
  console.log(`Removed from vector store: ${stats.orphanedVectorFilesRemoved}`);
  console.log(`Added to vector store:     ${stats.missingFromVectorStore}`);

  console.log('\n✅ Cleanup complete!');
}

main().catch(console.error);

