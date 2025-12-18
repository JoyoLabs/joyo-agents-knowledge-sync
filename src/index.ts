import * as functions from '@google-cloud/functions-framework';
import { Request, Response } from 'express';
import { NotionSync } from './sync/notion.sync';
import { SlackSync } from './sync/slack.sync';
import { FirestoreService } from './services/firestore.service';
import { getNotionConfig, getSlackConfig } from './config';

/**
 * Sync Notion pages to OpenAI Vector Store
 * Triggered by Cloud Scheduler (notion-sync-scheduler) every 6 hours
 */
functions.http('syncNotion', async (req: Request, res: Response) => {
  console.log('=== Notion Sync Started ===');
  const startTime = Date.now();

  try {
    const config = getNotionConfig();

    const notionSync = new NotionSync(
      config.notionApiKey,
      config.openaiApiKey,
      config.openaiVectorStoreId
    );

    const result = await notionSync.sync();

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`=== Notion Sync Completed in ${duration}s ===`);

    res.status(result.errors.length === 0 ? 200 : 207).json({
      success: result.errors.length === 0,
      duration: `${duration}s`,
      result,
    });
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error('Notion sync failed:', error);

    res.status(500).json({
      success: false,
      duration: `${duration}s`,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Sync Slack messages to OpenAI Vector Store
 * Triggered by Cloud Scheduler (slack-sync-scheduler) every 6 hours (offset 30min)
 */
functions.http('syncSlack', async (req: Request, res: Response) => {
  console.log('=== Slack Sync Started ===');
  const startTime = Date.now();

  try {
    const config = getSlackConfig();

    const slackSync = new SlackSync(
      config.slackBotToken,
      config.openaiApiKey,
      config.openaiVectorStoreId
    );

    const result = await slackSync.sync();

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`=== Slack Sync Completed in ${duration}s ===`);

    res.status(result.errors.length === 0 ? 200 : 207).json({
      success: result.errors.length === 0,
      duration: `${duration}s`,
      result,
    });
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error('Slack sync failed:', error);

    res.status(500).json({
      success: false,
      duration: `${duration}s`,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get current sync status from Firestore
 */
functions.http('getSyncStatus', async (req: Request, res: Response) => {
  try {
    const firestore = new FirestoreService();
    const status = await firestore.getAllSyncStatus();

    res.status(200).json({
      success: true,
      status,
    });
  } catch (error) {
    console.error('Failed to get sync status:', error);

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// NOTION SYNC CONTROL ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stop a running Notion sync gracefully
 * The sync will stop after completing the current chunk (~30 seconds max)
 */
functions.http('stopNotionSync', async (req: Request, res: Response) => {
  try {
    const firestore = new FirestoreService();
    const state = await firestore.getSyncState('notion');

    if (state?.status !== 'running') {
      res.status(400).json({
        success: false,
        message: 'No Notion sync is currently running',
        currentStatus: state?.status || 'unknown',
      });
      return;
    }

    await firestore.requestStop('notion');

    res.status(200).json({
      success: true,
      message: 'Stop requested. Sync will stop after current chunk completes (max ~30 seconds).',
    });
  } catch (error) {
    console.error('Failed to stop Notion sync:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Reset Notion sync state (use when sync is stuck)
 * This clears all progress and allows a fresh start
 */
functions.http('resetNotionSync', async (req: Request, res: Response) => {
  try {
    const firestore = new FirestoreService();
    await firestore.resetSync('notion');

    res.status(200).json({
      success: true,
      message: 'Notion sync state reset. Next sync will start fresh.',
    });
  } catch (error) {
    console.error('Failed to reset Notion sync:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SLACK SYNC CONTROL ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stop a running Slack sync gracefully
 * The sync will stop after completing the current message (~10 seconds max)
 */
functions.http('stopSlackSync', async (req: Request, res: Response) => {
  try {
    const firestore = new FirestoreService();
    const state = await firestore.getSyncState('slack');

    if (state?.status !== 'running') {
      res.status(400).json({
        success: false,
        message: 'No Slack sync is currently running',
        currentStatus: state?.status || 'unknown',
      });
      return;
    }

    await firestore.requestStop('slack');

    res.status(200).json({
      success: true,
      message: 'Stop requested. Sync will stop after current message completes.',
    });
  } catch (error) {
    console.error('Failed to stop Slack sync:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Reset Slack sync state (use when sync is stuck)
 * This clears all progress and allows a fresh start
 */
functions.http('resetSlackSync', async (req: Request, res: Response) => {
  try {
    const firestore = new FirestoreService();
    await firestore.resetSync('slack');

    res.status(200).json({
      success: true,
      message: 'Slack sync state reset. Next sync will start fresh.',
    });
  } catch (error) {
    console.error('Failed to reset Slack sync:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
