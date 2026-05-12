import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function resolvePath(envVal: string | undefined, defaultRelative: string): string {
  const raw = envVal ?? defaultRelative;
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

function envFlag(key: string, defaultValue = false): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export const config = {
  slack: {
    token:          requireEnv('SLACK_BOT_TOKEN'),
    channelPrefix:  process.env.SLACK_CHANNEL_PREFIX ?? 'zg',
    dmPrefix:       process.env.SLACK_DM_PREFIX ?? 'dm',
  },
  zalo: {
    credentialsPath: resolvePath(process.env.ZALO_CREDENTIALS_PATH, 'credentials.json'),
    skipMutedGroups: envFlag('ZALO_SKIP_MUTED_GROUPS'),
  },
  dataDir: resolvePath(process.env.DATA_DIR, 'data'),
} as const;