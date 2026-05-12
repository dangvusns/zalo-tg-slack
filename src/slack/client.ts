import { WebClient } from '@slack/web-api';
import { config } from '../config.js';

export const slack = new WebClient(config.slack.token);

const CHANNEL_NAME_MAX = 80;

function sanitizeChannelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .substring(0, CHANNEL_NAME_MAX);
}

export async function getOrCreateChannel(
  displayName: string,
  isDm: boolean,
): Promise<string> {
  const prefix = isDm ? config.slack.dmPrefix : config.slack.channelPrefix;
  const baseName = sanitizeChannelName(displayName);
  const channelName = `${prefix}-${baseName}`;

  const existing = await slack.conversations.list({
    exclude_archived: true,
    limit: 1000,
  });

  const found = existing.channels?.find(
    (ch) => ch.name === channelName,
  );

  if (found?.id) {
    return found.id;
  }

  const created = await slack.conversations.create({
    name: channelName,
    is_private: false,
  });

  if (!created.channel?.id) {
    throw new Error(`Failed to create channel: ${channelName}`);
  }

  console.log(`[Slack] Created channel: ${channelName} (${created.channel.id})`);
  return created.channel.id;
}