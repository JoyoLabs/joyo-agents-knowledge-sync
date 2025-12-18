/**
 * Test script for Slack sync
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { SlackSync } from '../src/sync/slack.sync';

const MAX_MESSAGES = parseInt(process.argv[2] || '10', 10);

async function main() {
  console.log(`=== Testing Slack Sync (${MAX_MESSAGES} messages max) ===\n`);

  // Check environment
  const requiredEnvVars = [
    'SLACK_BOT_TOKEN',
    'OPENAI_API_KEY',
    'OPENAI_VECTOR_STORE_ID',
  ];

  const missing = requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log('✅ Environment variables loaded\n');

  // Create sync instance
  const slackSync = new SlackSync(
    process.env.SLACK_BOT_TOKEN!,
    process.env.OPENAI_API_KEY!,
    process.env.OPENAI_VECTOR_STORE_ID!
  );

  // Run sync
  console.log(`Starting sync with maxMessages=${MAX_MESSAGES}...\n`);
  const result = await slackSync.sync({ maxMessages: MAX_MESSAGES });

  // Print results
  console.log('\n=== Results ===');
  console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`Added: ${result.processed.added}`);
  console.log(`Updated: ${result.processed.updated}`);
  console.log(`Deleted: ${result.processed.deleted}`);
  console.log(`Errored: ${result.processed.errored}`);

  if (result.errors.length > 0) {
    console.log('\nErrors/Warnings:');
    for (const error of result.errors.slice(0, 5)) {
      console.log(`  - ${error}`);
    }
  }

  console.log('\n🎉 Test completed!');
}

main().catch(console.error);

