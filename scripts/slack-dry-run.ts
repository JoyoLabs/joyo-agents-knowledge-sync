import { WebClient } from '@slack/web-api';
import * as dotenv from 'dotenv';

dotenv.config();

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const MIN_MESSAGE_LENGTH = 50;
const CHANNEL_BLACKLIST = [
  'linear-updates', 'github-updates',
  'new_update_alert', 'service-outages', 'google-cloud-outages', 'google-ads-outages',
];
const CHANNEL_BLACKLIST_PATTERNS = ['-purchases', '-updates'];

function isBlacklisted(name: string): boolean {
  if (CHANNEL_BLACKLIST.includes(name)) return true;
  return CHANNEL_BLACKLIST_PATTERNS.some(p => name.endsWith(p));
}

async function dryRun() {
  console.log('=== Slack Dry Run (expanded blacklist) ===\n');
  const startTime = Date.now();

  const channelsResp = await slack.conversations.list({
    types: 'public_channel',
    exclude_archived: true,
    limit: 200,
  });
  const allChannels = (channelsResp.channels || []).filter((c: any) => c.id && c.name);
  const channels = allChannels.filter((c: any) => !isBlacklisted(c.name));
  console.log(`Channels: ${allChannels.length} total, ${allChannels.length - channels.length} blacklisted, ${channels.length} to process\n`);

  let totalMessages = 0;
  let totalQualifying = 0;
  let totalApiCalls = 1;

  for (const channel of channels) {
    let channelMessages = 0;
    let channelQualifying = 0;
    let cursor: string | undefined;
    let pages = 0;

    do {
      try {
        const resp = await slack.conversations.history({
          channel: channel.id!,
          limit: 200,
          cursor,
        });
        totalApiCalls++;
        pages++;

        for (const msg of resp.messages || []) {
          channelMessages++;
          if (!msg.bot_id && !msg.subtype && msg.text && msg.text.length >= MIN_MESSAGE_LENGTH) {
            channelQualifying++;
          }
        }
        cursor = resp.response_metadata?.next_cursor;
        if (pages >= 10) {
          cursor = undefined;
        }
      } catch (e: any) {
        if (e.data?.error === 'not_in_channel') {
          try {
            await slack.conversations.join({ channel: channel.id! });
            continue;
          } catch {
            break;
          }
        }
        break;
      }
    } while (cursor);

    if (channelQualifying > 0) {
      console.log(`  #${channel.name}: ${channelQualifying} qualifying (of ${channelMessages} total)`);
    }
    totalMessages += channelMessages;
    totalQualifying += channelQualifying;
    await new Promise(r => setTimeout(r, 250));
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log('\n=== Results ===');
  console.log(`Channels processed: ${channels.length}`);
  console.log(`Messages fetched: ${totalMessages}`);
  console.log(`Qualifying: ${totalQualifying}`);
  console.log(`API calls: ${totalApiCalls}`);
  console.log(`Discovery time: ${elapsed.toFixed(1)}s`);
  console.log(`Est. full sync: ~${Math.round(totalQualifying * 2.5 / 2 / 60)} minutes`);
}

dryRun().catch(console.error);
