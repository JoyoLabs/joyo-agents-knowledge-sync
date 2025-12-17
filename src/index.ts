import * as functions from '@google-cloud/functions-framework';
import { Request, Response } from 'express';
import { NotionService, SlackService, FirestoreService } from './services';
import { getConfig, getNotionConfig, getSlackConfig } from './config';
import { SyncResult } from './types';

/**
 * Main sync function - syncs both Notion and Slack
 * Triggered by Cloud Scheduler every 6 hours or manually via HTTP
 */
functions.http('syncKnowledgeBase', async (req: Request, res: Response) => {
  console.log('=== Knowledge Base Sync Started ===');
  const startTime = Date.now();

  try {
    const config = getConfig();
    
    const results: SyncResult[] = [];
    const errors: string[] = [];

    // Sync Notion
    console.log('\n--- Starting Notion Sync ---');
    try {
      const notionService = new NotionService(
        config.notionApiKey,
        config.openaiApiKey,
        config.openaiVectorStoreId
      );
      const notionResult = await notionService.sync();
      results.push(notionResult);
      console.log('Notion sync completed:', notionResult);
    } catch (error) {
      const errorMsg = `Notion sync failed: ${error instanceof Error ? error.message : error}`;
      console.error(errorMsg);
      errors.push(errorMsg);
    }

    // Sync Slack
    console.log('\n--- Starting Slack Sync ---');
    try {
      const slackService = new SlackService(
        config.slackBotToken,
        config.openaiApiKey,
        config.openaiVectorStoreId
      );
      const slackResult = await slackService.sync();
      results.push(slackResult);
      console.log('Slack sync completed:', slackResult);
    } catch (error) {
      const errorMsg = `Slack sync failed: ${error instanceof Error ? error.message : error}`;
      console.error(errorMsg);
      errors.push(errorMsg);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n=== Knowledge Base Sync Completed in ${duration}s ===`);

    // Calculate totals
    const totals = {
      added: results.reduce((sum, r) => sum + r.added, 0),
      updated: results.reduce((sum, r) => sum + r.updated, 0),
      skipped: results.reduce((sum, r) => sum + r.skipped, 0),
      errored: results.reduce((sum, r) => sum + r.errored, 0),
    };

    const response = {
      success: errors.length === 0,
      duration: `${duration}s`,
      results,
      totals,
      errors: errors.length > 0 ? errors : undefined,
    };

    res.status(errors.length === 0 ? 200 : 207).json(response);
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error('Sync failed:', error);
    
    res.status(500).json({
      success: false,
      duration: `${duration}s`,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Sync only Notion - for manual triggers
 */
functions.http('syncNotion', async (req: Request, res: Response) => {
  console.log('=== Notion Sync Started ===');
  const startTime = Date.now();

  try {
    const config = getNotionConfig();
    
    const notionService = new NotionService(
      config.notionApiKey,
      config.openaiApiKey,
      config.openaiVectorStoreId
    );
    
    const result = await notionService.sync();
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`=== Notion Sync Completed in ${duration}s ===`);

    res.status(200).json({
      success: true,
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
 * Sync only Slack - for manual triggers
 */
functions.http('syncSlack', async (req: Request, res: Response) => {
  console.log('=== Slack Sync Started ===');
  const startTime = Date.now();

  try {
    const config = getSlackConfig();
    
    const slackService = new SlackService(
      config.slackBotToken,
      config.openaiApiKey,
      config.openaiVectorStoreId
    );
    
    const result = await slackService.sync();
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`=== Slack Sync Completed in ${duration}s ===`);

    res.status(200).json({
      success: true,
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



