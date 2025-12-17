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
