import { WebClient } from '@slack/web-api';
import * as dotenv from 'dotenv';
dotenv.config();

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const MIN_MESSAGE_LENGTH = 50;

function extractMessageText(msg: any): string {
  const parts: string[] = [];
  if (msg.text && msg.text.trim().length > 0) {
    parts.push(msg.text);
  }
  if (msg.attachments && msg.attachments.length > 0) {
    for (const att of msg.attachments) {
      if (att.pretext) parts.push(att.pretext);
      if (att.title && att.text) {
        parts.push(`${att.title}: ${att.text}`);
      } else if (att.text) {
        parts.push(att.text);
      } else if (att.fallback && !att.is_app_unfurl) {
        parts.push(att.fallback);
      }
    }
  }
  return parts.join('\n\n');
}

async function main() {
  const channelsResp = await slack.conversations.list({ types: 'public_channel', limit: 200 });
  const channel = channelsResp.channels?.find((c: any) => c.name === 'daily-standup');
  if (!channel || !channel.id) {
    console.log('Channel not found');
    return;
  }

  console.log('=== Testing daily-standup extraction ===\n');
  const resp = await slack.conversations.history({ channel: channel.id, limit: 5 });

  for (const msg of resp.messages || []) {
    const extracted = extractMessageText(msg);
    const wouldInclude = extracted.length >= MIN_MESSAGE_LENGTH;

    console.log('---');
    console.log('Status:', wouldInclude ? 'INCLUDED' : 'FILTERED');
    console.log('Extracted length:', extracted.length);
    console.log('Preview:', extracted.substring(0, 300));
    console.log('');
  }
}

main().catch(console.error);
