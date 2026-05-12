import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { config } from './config.js';

export interface ChannelMapping {
  slackChannelId: string;
  zaloId:        string;
  type:          0 | 1;
  name:          string;
}

interface StoreData {
  /** zaloId (as string key) → entry */
  channels:  Record<string, ChannelMapping>;
  /** `${type}:${zaloId}` → slackChannelId (reverse index) */
  zaloIndex: Record<string, string>;
}

const filePath = path.resolve(config.dataDir, 'channels.json');

function load(): StoreData {
  if (!existsSync(filePath)) return { channels: {}, zaloIndex: {} };
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as StoreData;
  } catch {
    return { channels: {}, zaloIndex: {} };
  }
}

function persist(data: StoreData): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function zaloKey(zaloId: string, type: 0 | 1): string {
  return `${type}:${zaloId}`;
}

let _data: StoreData = load();

export const store = {
  getChannelByZalo(zaloId: string, type: 0 | 1): string | undefined {
    return _data.zaloIndex[zaloKey(zaloId, type)];
  },

  getMappingByZalo(zaloId: string, type: 0 | 1): ChannelMapping | undefined {
    const channelId = _data.zaloIndex[zaloKey(zaloId, type)];
    if (!channelId) return undefined;
    return _data.channels[channelId];
  },

  set(entry: ChannelMapping): void {
    _data.channels[entry.slackChannelId] = entry;
    _data.zaloIndex[zaloKey(entry.zaloId, entry.type)] = entry.slackChannelId;
    persist(_data);
  },

  remove(channelId: string): ChannelMapping | undefined {
    const entry = _data.channels[channelId];
    if (!entry) return undefined;
    delete _data.channels[channelId];
    const key = zaloKey(entry.zaloId, entry.type);
    if (_data.zaloIndex[key] === channelId) {
      delete _data.zaloIndex[key];
    }
    persist(_data);
    return entry;
  },

  all(): ChannelMapping[] {
    return Object.values(_data.channels);
  },

  reload(): void {
    _data = load();
  },
};

const USER_CACHE_MAX = 500;
const _uidToName = new Map<string, string>();
const _normToUid = new Map<string, string>();
const _groupNameToUid = new Map<string, Map<string, string>>();

function _normName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

export const userCache = {
  save(uid: string, displayName: string): void {
    if (_uidToName.size >= USER_CACHE_MAX) {
      const firstUid = _uidToName.keys().next().value;
      if (firstUid) {
        const oldName = _uidToName.get(firstUid);
        _uidToName.delete(firstUid);
        if (oldName) _normToUid.delete(_normName(oldName));
      }
    }
    _uidToName.set(uid, displayName);
    _normToUid.set(_normName(displayName), uid);
  },

  resolveByName(rawName: string): string | undefined {
    return _normToUid.get(_normName(rawName));
  },

  saveForGroup(uid: string, displayName: string, zaloId: string): void {
    this.save(uid, displayName);
    let m = _groupNameToUid.get(zaloId);
    if (!m) { m = new Map(); _groupNameToUid.set(zaloId, m); }
    m.set(_normName(displayName), uid);
  },

  resolveByNameInGroup(rawName: string, zaloId: string): string | undefined {
    const norm = _normName(rawName);
    return _groupNameToUid.get(zaloId)?.get(norm) ?? _normToUid.get(norm);
  },

  getName(uid: string): string | undefined {
    return _uidToName.get(uid);
  },
};

const _aliasMap = new Map<string, string>();

export const aliasCache = {
  setAll(items: Array<{ userId: string; alias: string }>): void {
    _aliasMap.clear();
    for (const { userId, alias } of items) {
      if (alias?.trim()) _aliasMap.set(userId, alias.trim());
    }
  },

  get(userId: string): string | undefined {
    return _aliasMap.get(userId);
  },

  label(userId: string, realName: string): string {
    const alias = _aliasMap.get(userId);
    if (!alias || alias === realName) return realName;
    return `${alias} (${realName})`;
  },
};

export interface ZaloFriend {
  userId:      string;
  displayName: string;
  alias?:      string;
}

const FRIENDS_TTL_MS = 5 * 60 * 1000;
let _friends: ZaloFriend[] = [];
let _friendsTs: number = 0;

export const friendsCache = {
  set(list: ZaloFriend[]): void {
    _friends = list;
    _friendsTs = Date.now();
  },

  search(query: string, limit = 10): ZaloFriend[] {
    const q = query.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
    return _friends
      .filter(f => {
        const searchName = (f.alias || f.displayName).toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
        const realName = f.displayName.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
        return searchName.includes(q) || realName.includes(q);
      })
      .slice(0, limit);
  },

  isFresh(): boolean {
    return _friends.length > 0 && Date.now() - _friendsTs < FRIENDS_TTL_MS;
  },
};

export interface ZaloGroup {
  groupId:     string;
  name:        string;
  totalMember: number;
}

const GROUPS_TTL_MS = 5 * 60 * 1000;
let _groups: ZaloGroup[] = [];
let _groupsTs: number = 0;

export const groupsCache = {
  set(list: ZaloGroup[]): void {
    _groups = list;
    _groupsTs = Date.now();
  },

  search(query: string, limit = 10): ZaloGroup[] {
    const q = query.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
    return _groups
      .filter(g => {
        const n = g.name.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
        return n.includes(q);
      })
      .slice(0, limit);
  },

  isFresh(): boolean {
    return _groups.length > 0 && Date.now() - _groupsTs < GROUPS_TTL_MS;
  },
};