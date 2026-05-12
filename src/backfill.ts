import type { ZaloAPI } from './zalo/types.js';
import { store, userCache } from './store.js';
import { sendToSlack, SlackMessage } from './slack/handler.js';
import { escapeSlackMrkdwn, truncate, applyMentionsMrkdwn } from './utils/format.js';
import { downloadToTemp, cleanTemp } from './utils/media.js';
import path from 'path';

const BACKFILL_BATCH_SIZE = 100;

interface ZaloGroupMessageData {
  msgId: string;
  uidFrom: string;
  dName: string | null;
  ts: string;
  content: string | Record<string, unknown>;
  msgType: string;
  mentions?: Array<{ uid: string; pos: number; len: number; type: 0 | 1 }>;
}

interface ZaloGroupMessage {
  type: number;
  data: ZaloGroupMessageData;
}

function formatTimestamp(ts: string): string {
  const num = parseInt(ts, 10);
  if (isNaN(num) || num <= 0) return '';
  const date = new Date(num);
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear();
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

async function resolveDisplayName(api: ZaloAPI, uid: string, groupId: string): Promise<string> {
  const cached = userCache.getName(uid);
  if (cached?.trim()) return cached;

  try {
    const resp = await api.getUserInfo(uid) as {
      changed_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
      unchanged_profiles?: Record<string, unknown>;
    };
    const profile = (resp?.changed_profiles?.[uid] ?? resp?.unchanged_profiles?.[uid]) as
      | { displayName?: string; zaloName?: string }
      | undefined;
    const name = profile?.displayName?.trim() || profile?.zaloName?.trim();
    if (name) {
      userCache.saveForGroup(uid, name, groupId);
      return name;
    }
  } catch {}

  return uid;
}

async function processBackfilledMessage(
  api: ZaloAPI,
  msg: ZaloGroupMessage,
  groupId: string,
  channelId: string,
): Promise<void> {
  const data = msg.data;
  const senderName = await resolveDisplayName(api, data.uidFrom, groupId);
  const displayName = data.dName || senderName;
  const msgType = data.msgType || 'webchat';
  const timestamp = formatTimestamp(data.ts);

  console.log(`[Backfill] Processing ${msgType} msg ${data.msgId} from ${displayName}`);

  const content = data.content;
  const rawContent = typeof content === 'string' ? content : null;

  // Handle text/webchat messages (most common)
  if (msgType === 'text' || msgType === 'webchat' || rawContent) {
    const body = typeof content === 'string' ? content : '';
    if (!body.trim()) {
      console.log(`[Backfill] Skipping empty ${msgType} msg ${data.msgId}`);
      return;
    }

    const mentions = data.mentions;
    const bodyMrkdwn = mentions?.length
      ? applyMentionsMrkdwn(truncate(body), mentions)
      : escapeSlackMrkdwn(truncate(body));

    const textWithTs = timestamp ? `_[${timestamp}]_\n${bodyMrkdwn}` : bodyMrkdwn;
    const slackMsg: SlackMessage = { type: 'text', text: textWithTs };
    await sendToSlack(channelId, displayName, slackMsg);
    console.log(`[Backfill] ✓ Sent ${msgType} msg ${data.msgId}`);
    return;
  }

  // Handle image/photo
  if (msgType === 'chat.photo' || msgType === 'image' || msgType === 'photo') {
    let url = '';
    let caption = '';
    try {
      const parsed = typeof content === 'object' ? content : {};
      url = (parsed.href as string) || '';
      caption = (parsed.title as string) || '';
      if (parsed.params) {
        try {
          const p = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : parsed.params;
          if (p.hd) url = p.hd;
        } catch {}
      }
    } catch {}
    if (!url) {
      console.log(`[Backfill] Skipping ${msgType} msg ${data.msgId}: no URL`);
      return;
    }
    const localPath = await downloadToTemp(url, `photo_${Date.now()}.jpg`);
    try {
      const captionWithTs = timestamp ? `_[${timestamp}]_${caption ? '\n' + caption : ''}` : caption;
      const slackMsg: SlackMessage = { type: 'photo', filePath: localPath, filename: 'photo.jpg', caption: captionWithTs || undefined };
      await sendToSlack(channelId, displayName, slackMsg);
      console.log(`[Backfill] ✓ Sent photo msg ${data.msgId}`);
    } finally { await cleanTemp(localPath); }
    return;
  }

  // Handle video
  if (msgType === 'video' || msgType === 'chat.video') {
    let url = '';
    try {
      const parsed = typeof content === 'object' ? content : {};
      url = (parsed.href as string) || '';
    } catch {}
    if (!url) {
      console.log(`[Backfill] Skipping video msg ${data.msgId}: no URL`);
      return;
    }
    const localPath = await downloadToTemp(url, `video_${Date.now()}.mp4`);
    try {
      const slackMsg: SlackMessage = { type: 'video', filePath: localPath, filename: 'video.mp4' };
      await sendToSlack(channelId, displayName, slackMsg);
      console.log(`[Backfill] ✓ Sent video msg ${data.msgId}`);
    } finally { await cleanTemp(localPath); }
    return;
  }

  // Handle voice
  if (msgType === 'voice' || msgType === 'chat.voice') {
    let url = '';
    try {
      const parsed = typeof content === 'object' ? content : {};
      url = (parsed.href as string) || '';
    } catch {}
    if (!url) {
      console.log(`[Backfill] Skipping voice msg ${data.msgId}: no URL`);
      return;
    }
    const ext = path.extname(url.split('?')[0] || '').toLowerCase() || '.m4a';
    const localPath = await downloadToTemp(url, `voice_${Date.now()}${ext}`);
    try {
      const slackMsg: SlackMessage = { type: 'voice', filePath: localPath, filename: 'voice.m4a' };
      await sendToSlack(channelId, displayName, slackMsg);
      console.log(`[Backfill] ✓ Sent voice msg ${data.msgId}`);
    } finally { await cleanTemp(localPath); }
    return;
  }

  // Handle file
  if (msgType === 'file' || msgType === 'chat.file') {
    let url = '';
    let filename = 'file';
    try {
      const parsed = typeof content === 'object' ? content : {};
      url = (parsed.href as string) || '';
      filename = (parsed.title as string) || 'file';
    } catch {}
    if (!url) {
      console.log(`[Backfill] Skipping file msg ${data.msgId}: no URL`);
      return;
    }
    const ext = path.extname(url.split('?')[0] || '').toLowerCase() || '.bin';
    const localPath = await downloadToTemp(url, `${filename}${ext}`);
    try {
      const slackMsg: SlackMessage = { type: 'file', filePath: localPath, filename };
      await sendToSlack(channelId, displayName, slackMsg);
      console.log(`[Backfill] ✓ Sent file msg ${data.msgId}`);
    } finally { await cleanTemp(localPath); }
    return;
  }

  // Handle link/webcontent
  if (msgType === 'link' || msgType === 'webcontent' || msgType === 'chat.link') {
    let url = '';
    let title = '';
    try {
      const parsed = typeof content === 'object' ? content : {};
      url = (parsed.href as string) || '';
      title = (parsed.title as string) || url;
    } catch {
      url = String(content);
      title = url;
    }
    if (!url) {
      console.log(`[Backfill] Skipping ${msgType} msg ${data.msgId}: no URL`);
      return;
    }
    const slackMsg: SlackMessage = { type: 'link', url, title };
    await sendToSlack(channelId, displayName, slackMsg);
    console.log(`[Backfill] ✓ Sent link msg ${data.msgId}`);
    return;
  }

  // Handle calls
  if (msgType === 'chat.videocall' || msgType === 'chat.voicecall') {
    const text = timestamp 
      ? `_[${timestamp}]_\n:phone: ${msgType === 'chat.voicecall' ? 'Voice call' : 'Video call'}`
      : `:phone: ${msgType === 'chat.voicecall' ? 'Voice call' : 'Video call'}`;
    const slackMsg: SlackMessage = { type: 'text', text };
    await sendToSlack(channelId, displayName, slackMsg);
    console.log(`[Backfill] ✓ Sent call msg ${data.msgId}`);
    return;
  }

  console.log(`[Backfill] Unknown msgType="${msgType}" for msg ${data.msgId}, content:`, 
    typeof content === 'string' ? content.slice(0, 100) : JSON.stringify(content).slice(0, 100));
  const fallbackText = timestamp ? `_[${timestamp}]_\n:robot_face: [${msgType}]` : `:robot_face: [${msgType}]`;
  const fallbackMsg: SlackMessage = { type: 'text', text: fallbackText };
  await sendToSlack(channelId, displayName, fallbackMsg);
}

export async function backfillGroups(
  api: ZaloAPI,
  concurrency = 3,
  onProgress?: (done: number, total: number, group: string) => void,
): Promise<{ succeeded: number; failed: number; skipped: number }> {
  const groups = store.all().filter(e => e.type === 1);
  console.log(`[Backfill] Found ${groups.length} groups to backfill`);

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let idx = 0;

  const processGroup = async (entry: { zaloId: string; name: string }): Promise<void> => {
    idx++;
    if (onProgress) onProgress(idx, groups.length, entry.name);

    if (store.isBackfilled(entry.zaloId)) {
      console.log(`[Backfill] Skipping ${entry.name} (already backfilled)`);
      skipped++;
      return;
    }

    try {
      console.log(`[Backfill] Fetching history for ${entry.name}...`);
      const result = await api.getGroupChatHistory(entry.zaloId, BACKFILL_BATCH_SIZE) as {
        groupMsgs?: ZaloGroupMessage[];
        more?: number;
      };

      if (!result?.groupMsgs?.length) {
        console.log(`[Backfill] No messages found for ${entry.name}`);
        store.setLastBackfilled(entry.zaloId, Date.now());
        skipped++;
        return;
      }

      const channelId = store.getChannelByZalo(entry.zaloId, 1);
      if (!channelId) {
        console.warn(`[Backfill] No channel for ${entry.name}`);
        skipped++;
        return;
      }

      console.log(`[Backfill] Processing ${result.groupMsgs.length} messages for ${entry.name}`);

      // Sort by timestamp ascending (oldest first) for chronological order
      const sortedMsgs = [...result.groupMsgs].sort((a, b) => {
        const tsA = parseInt(a.data.ts, 10) || 0;
        const tsB = parseInt(b.data.ts, 10) || 0;
        return tsA - tsB;
      });

      for (const msg of sortedMsgs) {
        try {
          await processBackfilledMessage(api, msg, entry.zaloId, channelId);
        } catch (err) {
          console.error(`[Backfill] Failed to process msg ${msg.data.msgId}:`, err);
        }
      }

      store.setLastBackfilled(entry.zaloId, Date.now());
      console.log(`[Backfill] ✓ ${entry.name} (${result.groupMsgs.length} messages)`);
      succeeded++;
    } catch (err) {
      console.error(`[Backfill] ✗ ${entry.name}:`, err);
      failed++;
    }
  };

  for (let i = 0; i < groups.length; i += concurrency) {
    const batch = groups.slice(i, i + concurrency);
    await Promise.all(batch.map(processGroup));
  }

  console.log(`[Backfill] Done: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped`);
  return { succeeded, failed, skipped };
}