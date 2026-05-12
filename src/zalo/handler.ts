import { ThreadType } from 'zca-js';
import { createReadStream } from 'fs';
import path from 'path';
import QRCode from 'qrcode';

import type { ZaloAPI, ZaloMessage, ZaloMediaContent, ZaloGroupInfoResponse } from './types.js';
import { ZALO_MSG_TYPES } from './types.js';
import { store, userCache, aliasCache } from '../store.js';
import { getOrCreateChannel } from '../slack/client.js';
import { sendToSlack, SlackMessage, SlackBankCardMessage } from '../slack/handler.js';
import { config } from '../config.js';
import { downloadToTemp, cleanTemp } from '../utils/media.js';
import { channelCaption, truncate, escapeSlackMrkdwn, applyMentionsMrkdwn } from '../utils/format.js';

interface BankCardInfo {
  bankName: string;
  accountNumber: string;
  holderName?: string;
  vietqr: string;
}

function parseBankCardHtml(html: string): BankCardInfo | null {
  const ptags = [...html.matchAll(/<p[^>]*>([^<]+)<\/p>/g)]
    .map(m => m[1].trim()).filter(t => t.length > 0);

  const normalised = html.replace(/&amp;/g, '&');
  const contentMatch = normalised.match(/content=([^&"< ]+)/);
  if (!contentMatch) return null;
  const vietqr = decodeURIComponent(contentMatch[1]);

  const numericTags = ptags.filter(t => /^\d+$/.test(t));
  const textTags = ptags.filter(t => !/^\d+$/.test(t));

  const accountNumber = numericTags.find(t => t.length !== 6) ?? numericTags[1] ?? numericTags[0] ?? '';
  const bankName = textTags[0] ?? '';
  const holderName = textTags[1]?.trim() || undefined;

  if (!vietqr) return null;
  return { bankName, accountNumber, holderName, vietqr };
}

async function populateGroupMemberCache(api: ZaloAPI, groupId: string): Promise<void> {
  try {
    const info = await api.getGroupInfo(groupId) as {
      gridInfoMap?: Record<string, {
        memVerList?: string[];
        totalMember?: number;
      }>;
    };
    const groupData = info?.gridInfoMap?.[groupId];
    if (!groupData) {
      console.warn(`[Zalo] getGroupInfo: no data for group ${groupId}`);
      return;
    }

    const uids = (groupData.memVerList ?? [])
      .map(s => s.split('_')[0])
      .filter(Boolean);
    if (uids.length === 0) {
      console.warn(`[Zalo] group ${groupId}: empty memVerList (totalMember=${groupData.totalMember})`);
      return;
    }

    const BATCH = 50;
    let saved = 0;
    for (let i = 0; i < uids.length; i += BATCH) {
      const batch = uids.slice(i, i + BATCH);
      const resp = await api.getUserInfo(batch) as {
        changed_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
        unchanged_profiles?: Record<string, unknown>;
      };
      const profiles = resp?.changed_profiles ?? {};
      const unchanged = resp?.unchanged_profiles ?? {};
      for (const uid of batch) {
        const p = (profiles[uid] ?? unchanged[uid]) as { displayName?: string; zaloName?: string } | undefined;
        const name = p?.displayName?.trim() || p?.zaloName?.trim();
        if (uid && name) { userCache.saveForGroup(uid, name, groupId); saved++; }
      }
    }
    console.log(`[Zalo] Cached ${saved}/${uids.length} members for group ${groupId}`);
  } catch (err) {
    console.warn(`[Zalo] populateGroupMemberCache failed for ${groupId}:`, err);
  }
}

interface GroupInfoEntry { name: string; avt?: string; ts: number }
const _groupInfoCache = new Map<string, GroupInfoEntry>();
const GROUP_INFO_TTL = 5 * 60 * 1000;

async function getCachedGroupInfo(
  api: ZaloAPI,
  zaloId: string,
): Promise<{ name?: string; avt?: string }> {
  const hit = _groupInfoCache.get(zaloId);
  if (hit && Date.now() - hit.ts < GROUP_INFO_TTL) return hit;
  try {
    const info = await api.getGroupInfo(zaloId) as ZaloGroupInfoResponse;
    const entry: GroupInfoEntry = {
      name: info?.gridInfoMap?.[zaloId]?.name ?? '',
      avt: info?.gridInfoMap?.[zaloId]?.avt,
      ts: Date.now(),
    };
    _groupInfoCache.set(zaloId, entry);
    return entry;
  } catch { return {}; }
}

interface ZaloMuteEntry {
  id: string;
  duration: number;
  startTime: number;
  systemTime?: number;
  currentTime?: number;
}

const MUTED_GROUPS_TTL = 60 * 1000;
let _mutedGroupsCache: { ids: Set<string>; ts: number } | null = null;

function isActiveMute(entry: ZaloMuteEntry): boolean {
  if (entry.duration === -1) return true;
  if (entry.duration <= 0) return false;
  const now = entry.currentTime ?? entry.systemTime ?? Math.floor(Date.now() / 1000);
  const expiresAt = entry.startTime + entry.duration;
  return now < expiresAt;
}

async function isMutedZaloGroup(api: ZaloAPI, groupId: string): Promise<boolean> {
  if (!config.zalo.skipMutedGroups) return false;

  const cached = _mutedGroupsCache;
  if (cached && Date.now() - cached.ts < MUTED_GROUPS_TTL) {
    return cached.ids.has(groupId);
  }

  try {
    const muteInfo = await api.getMute() as { groupChatEntries?: ZaloMuteEntry[] };
    const mutedIds = new Set(
      (muteInfo.groupChatEntries ?? [])
        .filter(isActiveMute)
        .map(entry => String(entry.id)),
    );
    _mutedGroupsCache = { ids: mutedIds, ts: Date.now() };
    return mutedIds.has(groupId);
  } catch (err) {
    console.warn('[Zalo→Slack] Failed to check muted Zalo groups; forwarding message:', err);
    return false;
  }
}

const _pendingChannels = new Map<string, Promise<string>>();

async function resolveUserDisplayName(api: ZaloAPI, uid: string | undefined, fallback = 'ai đó'): Promise<string> {
  const cleanUid = uid?.trim();
  if (!cleanUid) return fallback;

  const cached = userCache.getName(cleanUid);
  if (cached?.trim()) return cached;

  try {
    const resp = await api.getUserInfo(cleanUid) as {
      changed_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
      unchanged_profiles?: Record<string, unknown>;
    };
    const profile = (resp?.changed_profiles?.[cleanUid] ?? resp?.unchanged_profiles?.[cleanUid]) as
      | { displayName?: string; zaloName?: string }
      | undefined;
    const name = profile?.displayName?.trim() || profile?.zaloName?.trim();
    if (name) {
      userCache.save(cleanUid, name);
      return name;
    }
  } catch (err) {
    console.warn(`[Zalo] resolveUserDisplayName failed for ${cleanUid}:`, err);
  }

  return cleanUid || fallback;
}

async function getOrCreateSlackChannel(
  zaloId: string,
  type: 0 | 1,
  displayName: string,
): Promise<string> {
  const existing = store.getChannelByZalo(zaloId, type);
  if (existing) return existing;

  const pendingKey = `${type}:${zaloId}`;
  const inFlight = _pendingChannels.get(pendingKey);
  if (inFlight) return inFlight;

  const promise = getOrCreateChannel(displayName, type === 0).finally(() => {
    _pendingChannels.delete(pendingKey);
  });
  _pendingChannels.set(pendingKey, promise);

  const channelId = await promise;
  store.set({ slackChannelId: channelId, zaloId, type, name: displayName });
  console.log(`[Zalo→Slack] Channel created: "${displayName}" (${channelId})`);
  return channelId;
}

function parseContent(raw: string | ZaloMediaContent | Record<string, unknown>): {
  text: string | null;
  media: ZaloMediaContent;
} {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as ZaloMediaContent;
      return { text: null, media: parsed };
    } catch {
      return { text: raw, media: {} };
    }
  }
  return { text: null, media: raw as ZaloMediaContent };
}

const _memberCacheLoaded = new Set<string>();

const _inFlightMsgIds = new Set<string>();

export async function setupZaloHandler(api: ZaloAPI): Promise<void> {
  for (const entry of store.all()) {
    if (entry.type === 1) {
      void populateGroupMemberCache(api, entry.zaloId);
      _memberCacheLoaded.add(entry.zaloId);
    }
  }

  try {
    const result = await api.getAliasList() as { items?: Array<{ userId: string; alias: string }> };
    if (result?.items?.length) {
      aliasCache.setAll(result.items);
      console.log(`[Zalo] Loaded ${result.items.length} aliases from address book`);
    }
  } catch (err) {
    console.warn('[Zalo] Failed to load alias list:', err);
  }

  api.listener.on('message', async (msg: ZaloMessage) => {
    try {
      const _primaryMsgId = msg.data.msgId;
      if (_primaryMsgId) {
        if (_inFlightMsgIds.has(_primaryMsgId)) {
          console.log(`[Zalo→Slack] Skip duplicate msgId=${_primaryMsgId}`);
          return;
        }
        _inFlightMsgIds.add(_primaryMsgId);
        setTimeout(() => _inFlightMsgIds.delete(_primaryMsgId), 10_000);
      }

      const zaloId = msg.threadId;
      const type = msg.type as 0 | 1;
      const senderName = msg.data.dName ?? msg.data.uidFrom;
      const msgType = msg.data.msgType ?? ZALO_MSG_TYPES.TEXT;

      if (type === ThreadType.Group && await isMutedZaloGroup(api, zaloId)) {
        console.log(`[Zalo→Slack] Skip muted group ${zaloId}`);
        return;
      }

      if (type === 1 && !_memberCacheLoaded.has(zaloId)) {
        _memberCacheLoaded.add(zaloId);
        void populateGroupMemberCache(api, zaloId);
      }

      if (type === ThreadType.Group) {
        userCache.saveForGroup(msg.data.uidFrom, senderName, zaloId);
      } else {
        userCache.save(msg.data.uidFrom, senderName);
      }

      const { text, media } = parseContent(msg.data.content);

      const _eagerMediaUrl = (() => {
        if (msgType === ZALO_MSG_TYPES.VIDEO || msgType === ZALO_MSG_TYPES.VOICE ||
            msgType === ZALO_MSG_TYPES.GIF || msgType === ZALO_MSG_TYPES.FILE) return media.href;
        if (msgType === ZALO_MSG_TYPES.PHOTO) {
          let u = media.href;
          try { const p = JSON.parse(media.params ?? '{}') as { hd?: string }; if (p.hd) u = p.hd; } catch {}
          return u;
        }
        return undefined;
      })();
      const _extGuess = _eagerMediaUrl
        ? (path.extname(_eagerMediaUrl.split('?')[0] ?? '').toLowerCase() || '.bin')
        : '.bin';
      const earlyDlPromise = _eagerMediaUrl
        ? downloadToTemp(_eagerMediaUrl, `dl_${Date.now()}${_extGuess}`)
        : null;

      let displayName = senderName;
      if (type === ThreadType.Group) {
        const info = await getCachedGroupInfo(api, zaloId);
        displayName = info.name || senderName;
      } else {
        const realName = await resolveUserDisplayName(api, zaloId, senderName);
        displayName = aliasCache.label(zaloId, realName);
      }

      const channelId = await getOrCreateSlackChannel(zaloId, type, displayName);

      if (msgType === ZALO_MSG_TYPES.TEXT || (text !== null)) {
        const body = text ?? (typeof msg.data.content === 'string' ? msg.data.content : '');
        if (!body.trim()) return;
        const mentions = msg.data.mentions;
        const bodyMrkdwn = mentions?.length
          ? applyMentionsMrkdwn(truncate(body), mentions)
          : escapeSlackMrkdwn(truncate(body));
        const slackMsg: SlackMessage = { type: 'text', text: `${channelCaption(senderName)}${bodyMrkdwn}` };
        await sendToSlack(channelId, senderName, slackMsg);
        return;
      }

      if (msgType === ZALO_MSG_TYPES.PHOTO) {
        let url = media.href;
        if (media.params) {
          try {
            const p = JSON.parse(media.params) as { hd?: string };
            if (p.hd) url = p.hd;
          } catch { /* ignore */ }
        }
        if (!url) { console.warn('[ZaloHandler] Photo: no URL found in content:', media); return; }

        const photoCaption = media.title?.trim() || undefined;
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, `photo_${Date.now()}.jpg`));
        try {
          const slackMsg: SlackMessage = {
            type: 'photo',
            filePath: localPath,
            filename: 'photo.jpg',
            caption: photoCaption,
          };
          await sendToSlack(channelId, senderName, slackMsg);
        } finally { await cleanTemp(localPath); }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.DOODLE) {
        const url = media.href || media.thumb;
        if (!url) { console.warn('[ZaloHandler] Doodle: no URL'); return; }
        const localPath = await downloadToTemp(url, `doodle_${Date.now()}.jpg`);
        try {
          const slackMsg: SlackMessage = { type: 'photo', filePath: localPath, filename: 'doodle.jpg' };
          await sendToSlack(channelId, senderName, slackMsg);
        } finally { await cleanTemp(localPath); }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.GIF) {
        const url = media.href;
        if (!url) {
          console.warn('[ZaloHandler] GIF: no URL found in content:', media);
          return;
        }
        const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.mp4';
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, `gif_${Date.now()}${ext}`));
        try {
          const slackMsg: SlackMessage = { type: 'video', filePath: localPath, filename: 'animation.gif' };
          await sendToSlack(channelId, senderName, slackMsg);
        } finally { await cleanTemp(localPath); }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.FILE) {
        const url = media.href;
        const fileName = media.title ?? `file_${Date.now()}`;
        if (!url) {
          console.warn('[ZaloHandler] File: no URL found in content:', media);
          return;
        }
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, fileName));
        try {
          const slackMsg: SlackMessage = { type: 'file', filePath: localPath, filename: fileName };
          await sendToSlack(channelId, senderName, slackMsg);
        } finally { await cleanTemp(localPath); }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.VIDEO) {
        const url = media.href;
        if (!url) { console.warn('[ZaloHandler] Video: no URL found in content:', media); return; }
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, `video_${Date.now()}.mp4`));
        try {
          const slackMsg: SlackMessage = { type: 'video', filePath: localPath, filename: 'video.mp4' };
          await sendToSlack(channelId, senderName, slackMsg);
        } finally { await cleanTemp(localPath); }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.VOICE) {
        const url = media.href;
        if (!url) { console.warn('[ZaloHandler] Voice: no URL found in content:', media); return; }
        const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.m4a';
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, `voice_${Date.now()}${ext}`));
        try {
          const slackMsg: SlackMessage = { type: 'voice', filePath: localPath, filename: 'voice.m4a' };
          await sendToSlack(channelId, senderName, slackMsg);
        } finally { await cleanTemp(localPath); }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.STICKER) {
        const stickerId = media.id;
        if (!stickerId) {
          console.warn('[ZaloHandler] Sticker: no id in content:', media);
          return;
        }
        try {
          const details: unknown[] = await api.getStickersDetail([stickerId]);
          const detail = details?.[0] as { stickerWebpUrl?: string; stickerUrl?: string; stickerSpriteUrl?: string } | undefined;
          const url: string | undefined =
            detail?.stickerWebpUrl ?? detail?.stickerUrl ?? detail?.stickerSpriteUrl;
          if (!url) {
            console.warn('[ZaloHandler] Sticker: no URL in detail:', detail);
            return;
          }
          const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.webp';
          const localPath = await downloadToTemp(url, `sticker_${Date.now()}${ext}`);
          try {
            const slackMsg: SlackMessage = { type: 'sticker', filePath: localPath, filename: 'sticker.webp' };
            await sendToSlack(channelId, senderName, slackMsg);
          } finally { await cleanTemp(localPath); }
        } catch (stickerErr) {
          console.error('[ZaloHandler] Sticker fetch error:', stickerErr);
        }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.LINK) {
        const href = media.href;
        const title = media.title ?? href;
        if (!href) return;
        const slackMsg: SlackMessage = { type: 'link', url: href, title };
        await sendToSlack(channelId, senderName, slackMsg);
        return;
      }

      if (msgType === ZALO_MSG_TYPES.WEBCONTENT) {
        if (media.action === 'zinstant.bankcard' && media.params) {
          try {
            const parsedParams = JSON.parse(media.params) as {
              pcItem?: { data_url?: string };
              item?: { data_url?: string };
            };
            const dataUrl = parsedParams.pcItem?.data_url ?? parsedParams.item?.data_url;
            if (dataUrl) {
              const htmlResp = await fetch(`${dataUrl}?data=html`);
              const html = await htmlResp.text();
              const info = parseBankCardHtml(html);
              if (info) {
                const qrBuf = await QRCode.toBuffer(info.vietqr, {
                  width: 300, margin: 2,
                  color: { dark: '#000000ff', light: '#ffffffff' },
                });
                const slackMsg: SlackBankCardMessage = {
                  type: 'bankcard',
                  bankName: info.bankName,
                  accountNumber: info.accountNumber,
                  holderName: info.holderName,
                  qrBuffer: qrBuf,
                };
                await sendToSlack(channelId, senderName, slackMsg);
                return;
              }
            }
          } catch (err) {
            console.error('[ZaloHandler] bankcard parse error:', err);
          }
        }

        let label = media.title || '';
        try {
          if (media.params) {
            const p = JSON.parse(media.params) as {
              customMsg?: { msg?: { vi?: string; en?: string } };
            };
            const vi = p.customMsg?.msg?.vi;
            const en = p.customMsg?.msg?.en;
            if (vi && vi.trim()) label = vi.trim();
            else if (en && en.trim()) label = en.trim();
          }
        } catch { /* use fallback */ }
        if (!label) label = '[Nội dung web]';

        const ACTION_ICONS: Record<string, string> = {
          'zinstant.bankcard': ':bank:',
          'zinstant.transfer': ':money_with_wings:',
          'zinstant.invoice': ':receipt:',
          'zinstant.qr': ':camera:',
        };
        const icon = ACTION_ICONS[media.action ?? ''] ?? ':clipboard:';
        const slackMsg: SlackMessage = { type: 'text', text: `${channelCaption(senderName)}${icon} ${label}` };
        await sendToSlack(channelId, senderName, slackMsg);
        return;
      }

      if (msgType === ZALO_MSG_TYPES.LOCATION) {
        let lat: number | undefined;
        let lng: number | undefined;
        try {
          const p = JSON.parse(media.params ?? '{}') as { latitude?: number; longitude?: number };
          lat = p.latitude;
          lng = p.longitude;
        } catch { /* ignore */ }

        if (lat !== undefined && lng !== undefined) {
          const slackMsg: SlackMessage = { type: 'location', latitude: lat, longitude: lng };
          await sendToSlack(channelId, senderName, slackMsg);
        } else {
          const mapsUrl = media.href || '#';
          const slackMsg: SlackMessage = { type: 'link', url: mapsUrl, title: 'Vị trí' };
          await sendToSlack(channelId, senderName, slackMsg);
        }
        return;
      }

      {
        const rawContent = msg.data.content;
        const contactUid: string | undefined =
          (typeof rawContent === 'object' && rawContent !== null && 'contactUid' in rawContent)
            ? String((rawContent as Record<string, unknown>).contactUid)
            : (media.contactUid ? String(media.contactUid) : undefined);

        if (contactUid || msgType === ZALO_MSG_TYPES.CONTACT) {
          const uid = contactUid ?? '';
          let contactName = userCache.getName(uid) ?? uid;
          if (uid && contactName === uid) {
            try {
              const resp = await api.getUserInfo(uid) as {
                changed_profiles?: Record<string, { displayName?: string }>;
              };
              contactName = resp?.changed_profiles?.[uid]?.displayName ?? uid;
              if (contactName !== uid) userCache.save(uid, contactName);
            } catch { /* non-fatal */ }
          }
          const slackMsg: SlackMessage = { type: 'contact', name: contactName, uid };
          await sendToSlack(channelId, senderName, slackMsg);
          return;
        }
      }

      console.log(`[ZaloHandler] Unhandled msgType="${msgType}" content:`, JSON.stringify(msg.data.content));
      const fallbackMsg: SlackMessage = { type: 'text', text: `${channelCaption(senderName)}_:robot_face: [${msgType}]_` };
      await sendToSlack(channelId, senderName, fallbackMsg);

    } catch (err) {
      console.error('[ZaloHandler] Error:', err);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('group_event', async (event: any) => {
    try {
      const type = event?.type as string | undefined;
      const groupId = String(event?.threadId ?? event?.data?.groupId ?? '');
      if (!groupId) return;

      // Group name change - update channel topic if needed
      if (type === 'update' || type === 'update_setting') {
        const data = event?.data;
        const newName: string = (
          (data?.groupName as string | undefined) ??
          (data?.name as string | undefined) ??
          ''
        ).trim();
        if (newName) {
          _groupInfoCache.delete(groupId);
          console.log(`[ZaloHandler] Group ${groupId} renamed to "${newName}"`);
        }
        return;
      }

      // Log join/leave events but don't send to Slack (archival only)
      const LOG_TYPES = new Set(['join', 'leave', 'remove_member', 'block_member']);
      if (type && LOG_TYPES.has(type)) {
        const members: Array<{ dName?: string }> = event?.data?.updateMembers ?? [];
        const names = members.map(m => m.dName ?? '?').join(', ');
        console.log(`[ZaloHandler] Group ${groupId} event: ${type} - ${names}`);
      }
    } catch (err) {
      console.error('[ZaloHandler] GroupEvent error:', err);
    }
  });
}