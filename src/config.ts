import { Config } from './types';

export function getConfig(): Config {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const openaiVectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;
  const notionApiKey = process.env.NOTION_API_KEY;
  const slackBotToken = process.env.SLACK_BOT_TOKEN;

  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }
  if (!openaiVectorStoreId) {
    throw new Error('OPENAI_VECTOR_STORE_ID environment variable is required');
  }
  if (!notionApiKey) {
    throw new Error('NOTION_API_KEY environment variable is required');
  }
  if (!slackBotToken) {
    throw new Error('SLACK_BOT_TOKEN environment variable is required');
  }

  return {
    openaiApiKey,
    openaiVectorStoreId,
    notionApiKey,
    slackBotToken,
  };
}

export function getNotionConfig(): Pick<Config, 'openaiApiKey' | 'openaiVectorStoreId' | 'notionApiKey'> {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const openaiVectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;
  const notionApiKey = process.env.NOTION_API_KEY;

  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }
  if (!openaiVectorStoreId) {
    throw new Error('OPENAI_VECTOR_STORE_ID environment variable is required');
  }
  if (!notionApiKey) {
    throw new Error('NOTION_API_KEY environment variable is required');
  }

  return {
    openaiApiKey,
    openaiVectorStoreId,
    notionApiKey,
  };
}

export function getSlackConfig(): Pick<Config, 'openaiApiKey' | 'openaiVectorStoreId' | 'slackBotToken'> {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const openaiVectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;
  const slackBotToken = process.env.SLACK_BOT_TOKEN;

  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }
  if (!openaiVectorStoreId) {
    throw new Error('OPENAI_VECTOR_STORE_ID environment variable is required');
  }
  if (!slackBotToken) {
    throw new Error('SLACK_BOT_TOKEN environment variable is required');
  }

  return {
    openaiApiKey,
    openaiVectorStoreId,
    slackBotToken,
  };
}



