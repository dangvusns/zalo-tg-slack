# zalo-slack-archiver

A one-way archival bridge from **Zalo** to **Slack**, designed for AI analysis via Dropbox Dash or similar tools.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running](#running)
- [Project Structure](#project-structure)
- [Security Considerations](#security-considerations)

---

## Overview

This tool archives all Zalo messages (including your own messages sent from the Zalo app) to Slack channels for historical record and AI analysis. Unlike the previous Telegram bridge, this is a **one-way** archival system - there's no ability to send messages back to Zalo.

### Why Slack?

- **Searchable history** - All messages searchable in Slack
- **AI Analysis** - Works with Dropbox Dash and other AI tools for conversation analysis
- **Simple structure** - Groups → `#zg-{name}` channels, DMs → `#dm-{name}` channels

---

## Architecture

```
Zalo WebSocket API
        |
   zalo/client.ts         (authentication, session management)
        |
   zalo/handler.ts        (decode incoming Zalo events → forward to Slack)
        |
   slack/client.ts        (channel creation/reuse)
   slack/handler.ts       (format and send messages to Slack)
        |
   store.ts               (channel mappings, user cache, aliases)
        |
Slack Bot API (via @slack/web-api)
```

**Key differences from the Telegram version:**

- **One-way only** - No reverse sync, no commands, no reply chains
- **All messages archived** - Including messages you send from Zalo (removed `isSelf` filter)
- **Simpler storage** - Just ZaloConvo → SlackChannel mapping; no msg-map.json
- **No polls** - Polls are logged as unhandled message types
- **No reactions** - Reactions not synced (archival only)

---

## Features

### Message Types — Zalo to Slack

| Zalo Type | Slack Output |
|-----------|--------------|
| `webchat` (text) | `chat.postMessage` with mrkdwn formatting |
| `chat.photo` | `files.uploadV2` with caption |
| `chat.video.msg` | `files.uploadV2` (MP4) |
| `chat.gif` | `files.uploadV2` (animated) |
| `share.file` | `files.uploadV2` with filename |
| `chat.voice` | `files.uploadV2` (M4A) |
| `chat.sticker` | `files.uploadV2` (WebP image) |
| `chat.doodle` | `files.uploadV2` (JPEG) |
| `chat.recommended` (link) | `chat.postMessage` with unfurl |
| `chat.location.new` | Google Maps link in message |
| `chat.webcontent` (bank card) | VietQR image + account details |
| `chat.forward` (contact) | Contact card text message |
| `group.poll` | Logged as unhandled (no sync) |

### Self Messages

**Important:** This bridge archives ALL messages, including those you send from the Zalo app. This provides a complete conversation history for AI analysis.

---

## Requirements

| Dependency | Version | Notes |
|------------|---------|-------|
| Node.js | >= 18 | ESM support required |
| npm | >= 9 | |
| Slack App | — | Created via https://api.slack.com/apps |

**Required Slack Bot Scopes:**

- `channels:history` - Read channel messages
- `channels:manage` - Create public channels
- `chat:write` - Post messages
- `files:write` - Upload files (photos, videos, documents)
- `users:read` - Resolve user names (optional, for future features)

---

## Installation

```bash
git clone https://github.com/williamcachamwri/zalo-tg
cd zalo-tg
npm install
cp .env.example .env
```

---

## Configuration

Edit `.env`:

```env
# Slack Bot Token (required)
# Get from: https://api.slack.com/apps -> Your App -> OAuth & Permissions -> Bot User OAuth Token
SLACK_BOT_TOKEN=xoxb-your-bot-token-here

# Channel name prefix for groups (default: zg)
# Groups will be created as #zg-{groupname}
SLACK_CHANNEL_PREFIX=zg

# Channel name prefix for DMs (default: dm)
# DMs will be created as #dm-{username}
SLACK_DM_PREFIX=dm

# Zalo credentials file path (default: credentials.json)
# ZALO_CREDENTIALS_PATH=./credentials.json

# Skip messages from muted Zalo groups (default: false)
# ZALO_SKIP_MUTED_GROUPS=false

# Data directory for channel mappings (default: data)
# DATA_DIR=./data
```

---

## Running

```bash
# Development — hot reload via tsx watch
npm run dev

# Production
npm run build
npm start
```

### First-Time Zalo Login

1. On first run without `credentials.json`, the bot will prompt you to scan a QR code.
2. Run `npm run dev` in a terminal
3. Scan the QR code with your Zalo app (Settings → QR Code Login)
4. A `credentials.json` file will be created for future runs

---

## Project Structure

```
src/
├── index.ts              Entry point. Initialises Slack client, Zalo client,
│                         attaches handler, starts listening.
├── config.ts             Reads and validates environment variables.
├── store.ts              In-memory and on-disk state:
│                           - channelStore (persisted, channels.json)
│                           - userCache (uid ↔ displayName)
│                           - aliasCache (contact nicknames)
│                           - friendsCache / groupsCache (search helpers)
├── slack/
│   ├── client.ts         Slack WebClient singleton; getOrCreateChannel helper.
│   └── handler.ts        Formats and sends messages to Slack channels.
├── zalo/
│   ├── client.ts         Zalo API initialisation and QR login flow.
│   ├── types.ts          TypeScript interfaces and ZALO_MSG_TYPES constant.
│   └── handler.ts        Processes Zalo listener events, forwards to Slack.
└── utils/
    ├── format.ts         Slack mrkdwn escaping, mention formatting.
    └── media.ts          Temporary file download and cleanup.
```

---

## Data Files

### `data/channels.json`

Maps each Zalo conversation ID (group or DM) to its Slack channel ID and metadata (display name, type). Created automatically when new conversations are first seen.

### `credentials.json`

Zalo session token. **Treat as sensitive** - equivalent to your Zalo account password. Never commit to version control.

---

## Security Considerations

- `.env` and `credentials.json` are listed in `.gitignore` - never commit them.
- `credentials.json` contains a Zalo session token. Protect it like a password.
- This is a single-user archival tool. Ensure your Slack workspace has appropriate access controls.
- All outbound requests use HTTPS/TLS. No credentials are logged.

---

## Migration from Telegram Bridge

This codebase was migrated from a bidirectional Zalo ↔ Telegram bridge. Key changes:

1. **Removed:** All Telegram code (`src/telegram/`)
2. **Simplified:** `store.ts` - no bidirectional message ID tracking
3. **Changed:** `isSelf` message filtering removed (archive all messages)
4. **Removed:** /login, /search, /recall, /topic commands
5. **Removed:** Reaction sync, poll sync, reply chain tracking
6. **Added:** Slack client and handler modules

See git history for the previous bidirectional implementation.