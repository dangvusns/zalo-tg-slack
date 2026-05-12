import type { ZaloAPI } from './zalo/types.js';
import { store, userCache } from './store.js';
import { getOrCreateChannel } from './slack/client.js';
import { sendToSlack, SlackMessage } from './slack/handler.js';
import { escapeSlackMrkdwn, truncate, channelCaption, applyMentionsMrkdwn } from './utils/format.js';
import { downloadToTemp, cleanTemp } from './utils/media.js';
import path from 'path';

const BACKFILL_BATCH_SIZE = 100;

interface ZaloGroupMessage {
  msgId: string;
  uidFrom: string;
  dName: string;
  ts: string;
  content: string;
  msgType: string;
  mentions?: Array<{ uid: string; pos: number; len: number; type: 0 | 1 }>;
}

async function getGroupDisplayName(api: ZaloAPI, groupId: string): Promise<string> {
  try {
    const info = await api.getGroupInfo(groupId) as {
      gridInfoMap?: Record<string, { name?: string }>;
    };
    return info?.gridInfoMap?.[groupId]?.name || groupId;
  } catch {
    return groupId;
  }
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
  const senderName = await resolveDisplayName(api, msg.uidFrom, groupId);
  const msgType = msg.msgType || 'text';

  console.log(`[Backfill] Processing ${msgType} msg ${msg.msgId} from ${senderName}`);

  if (msgType === 'text' || (msg.content && typeof msg.content === 'string')) {
    const body = typeof msg.content === 'string' ? msg.content : '';
    if (!body.trim()) {
      console.log(`[Backfill] Skipping empty text msg ${msg.msgId}`);
      return;
    }

    const mentions = msg.mentions;
    const bodyMrkdwn = mentions?.length
      ? applyMentionsMrkdwn(truncate(body), mentions)
      : escapeSlackMrkdwn(truncate(body));

    const slackMsg: SlackMessage = { type: 'text', text: bodyMrkdwn };
    await sendToSlack(channelId, senderName, slackMsg);
    console.log(`[Backfill] ✓ Sent text msg ${msg.msgId}`);
    return;
  }

  if (msgType === 'chat.videocall' || msgType === 'chat.voicecall') {
    console.log(`[Backfill] Skipping call msg ${msg.msgId}`);
    const slackMsg: SlackMessage = {
      type: 'text',
      text: `_:phone: ${msgType === 'chat.voicecall' ? 'Voice call' : 'Video call'}_`,
    };
    await sendToSlack(channelId, senderName, slackMsg);
    return;
  }

  if (msgType === 'webcontent' || msgType === 'link') {
    let url = '';
    let title = '';
    try {
      const parsed = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      url = parsed.href || '';
      title = parsed.title || url;
    } catch {
      url = String(msg.content);
      title = url;
    }
    if (!url) {
      console.log(`[Backfill] Skipping ${msgType} msg ${msg.msgId}: no URL`);
      return;
    }
    const slackMsg: SlackMessage = { type: 'link', url, title };
    await sendToSlack(channelId, senderName, slackMsg);
    console.log(`[Backfill] ✓ Sent link msg ${msg.msgId}`);
    return;
  }

  if (msgType === 'file') {
    let url = '';
    let filename = 'file';
    try {
      const parsed = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      url = parsed.href || '';
      filename = parsed.title || 'file';
    } catch {}
    if (!url) {
      console.log(`[Backfill] Skipping file msg ${msg.msgId}: no URL`);
      return;
    }
    const ext = path.extname(url.split('?')[0] || '').toLowerCase() || '.bin';
    const localPath = await downloadToTemp(url, `${filename}${ext}`);
    try {
      const slackMsg: SlackMessage = { type: 'file', filePath: localPath, filename };
      await sendToSlack(channelId, senderName, slackMsg);
      console.log(`[Backfill] ✓ Sent file msg ${msg.msgId}`);
    } finally { await cleanTemp(localPath); }
    return;
  }

  if (msgType === 'photo' || msgType === 'image') {
    let url = '';
    let caption = '';
    try {
      const parsed = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      url = parsed.href || '';
      caption = parsed.title || '';
      if (parsed.params) {
        try {
          const p = JSON.parse(parsed.params);
          if (p.hd) url = p.hd;
        } catch {}
      }
    } catch {}
    if (!url) {
      console.log(`[Backfill] Skipping ${msgType} msg ${msg.msgId}: no URL`);
      return;
    }
    const localPath = await downloadToTemp(url, `photo_${Date.now()}.jpg`);
    try {
      const slackMsg: SlackMessage = { type: 'photo', filePath: localPath, filename: 'photo.jpg', caption };
      await sendToSlack(channelId, senderName, slackMsg);
      console.log(`[Backfill] ✓ Sent photo msg ${msg.msgId}`);
    } finally { await cleanTemp(localPath); }
    return;
  }

  if (msgType === 'video') {
    let url = '';
    try {
      const parsed = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      url = parsed.href || '';
    } catch {}
    if (!url) {
      console.log(`[Backfill] Skipping video msg ${msg.msgId}: no URL`);
      return;
    }
    const localPath = await downloadToTemp(url, `video_${Date.now()}.mp4`);
    try {
      const slackMsg: SlackMessage = { type: 'video', filePath: localPath, filename: 'video.mp4' };
      await sendToSlack(channelId, senderName, slackMsg);
      console.log(`[Backfill] ✓ Sent video msg ${msg.msgId}`);
    } finally { await cleanTemp(localPath); }
    return;
  }

  if (msgType === 'voice') {
    let url = '';
    try {
      const parsed = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      url = parsed.href || '';
    } catch {}
    if (!url) {
      console.log(`[Backfill] Skipping voice msg ${msg.msgId}: no URL`);
      return;
    }
    const ext = path.extname(url.split('?')[0] || '').toLowerCase() || '.m4a';
    const localPath = await downloadToTemp(url, `voice_${Date.now()}${ext}`);
    try {
      const slackMsg: SlackMessage = { type: 'voice', filePath: localPath, filename: 'voice.m4a' };
      await sendToSlack(channelId, senderName, slackMsg);
      console.log(`[Backfill] ✓ Sent voice msg ${msg.msgId}`);
    } finally { await cleanTemp(localPath); }
    return;
  }

  console.log(`[Backfill] Unknown msgType="${msgType}" for msg ${msg.msgId}, content:`, 
    typeof msg.content === 'string' ? msg.content.slice(0, 100) : JSON.stringify(msg.content).slice(0, 100));
  const fallbackMsg: SlackMessage = { type: 'text', text: `_:robot_face: [${msgType}]_` };
  await sendToSlack(channelId, senderName, fallbackMsg);
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
      const result = await api.getGroupChatHistory(entry.zaloId, BACKFILL_BATCH_SIZE);

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

      for (const msg of result.groupMsgs) {
        try {
          console.log(`[Backfill] Raw msg ${msg.msgId}:`, JSON.stringify(msg).slice(0, 300));
          await processBackfilledMessage(api, msg, entry.zaloId, channelId);
        } catch (err) {
          console.error(`[Backfill] Failed to process msg ${msg.msgId}:`, err);
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