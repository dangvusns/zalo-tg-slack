import { createReadStream, statSync } from 'fs';
import { slack } from './client.js';
import { channelCaption, truncate, escapeSlackMrkdwn } from '../utils/format.js';

export interface SlackTextMessage {
  type: 'text';
  text: string;
}

export interface SlackMediaMessage {
  type: 'photo' | 'video' | 'voice' | 'file' | 'sticker';
  filePath: string;
  filename: string;
  caption?: string;
}

export interface SlackLinkMessage {
  type: 'link';
  url: string;
  title?: string;
}

export interface SlackLocationMessage {
  type: 'location';
  latitude: number;
  longitude: number;
}

export interface SlackContactMessage {
  type: 'contact';
  name: string;
  uid: string;
}

export interface SlackBankCardMessage {
  type: 'bankcard';
  bankName?: string;
  accountNumber?: string;
  holderName?: string;
  qrBuffer: Buffer;
}

export type SlackMessage =
  | SlackTextMessage
  | SlackMediaMessage
  | SlackLinkMessage
  | SlackLocationMessage
  | SlackContactMessage
  | SlackBankCardMessage;

export async function sendToSlack(
  channelId: string,
  senderName: string,
  message: SlackMessage,
): Promise<void> {
  const prefix = channelCaption(senderName);

  switch (message.type) {
    case 'text': {
      const text = `${prefix}${message.text}`;
      await slack.chat.postMessage({
        channel: channelId,
        text: truncate(text),
        unfurl_links: true,
        unfurl_media: true,
      });
      break;
    }

    case 'photo':
    case 'sticker': {
      const size = statSync(message.filePath).size;
      if (size < 1_000_000) {
        await slack.files.uploadV2({
          channel_id: channelId,
          file: createReadStream(message.filePath),
          filename: message.filename,
          initial_comment: message.caption ? `${prefix}${message.caption}` : prefix,
        });
      } else {
        await slack.chat.postMessage({
          channel: channelId,
          text: `${prefix}[Image too large: ${message.filename}]`,
        });
      }
      break;
    }

    case 'video':
    case 'voice':
    case 'file': {
      const size = statSync(message.filePath).size;
      const maxSize = 50 * 1024 * 1024; // 50MB Slack limit
      if (size < maxSize) {
        await slack.files.uploadV2({
          channel_id: channelId,
          file: createReadStream(message.filePath),
          filename: message.filename,
          initial_comment: message.caption ? `${prefix}${message.caption}` : prefix,
        });
      } else {
        await slack.chat.postMessage({
          channel: channelId,
          text: `${prefix}[File too large: ${message.filename} (${Math.round(size / 1024 / 1024)}MB)]`,
        });
      }
      break;
    }

    case 'link': {
      const text = `${prefix}<${message.url}|${escapeSlackMrkdwn(message.title || message.url)}>`;
      await slack.chat.postMessage({
        channel: channelId,
        text,
        unfurl_links: true,
        unfurl_media: true,
      });
      break;
    }

    case 'location': {
      const mapsUrl = `https://www.google.com/maps?q=${message.latitude},${message.longitude}`;
      const text = `${prefix}:round_pushpin: <${mapsUrl}|Location>`;
      await slack.chat.postMessage({
        channel: channelId,
        text,
        unfurl_links: true,
      });
      break;
    }

    case 'contact': {
      const text = `${prefix}:bust_in_silhouette: *Contact Card*\nName: *${escapeSlackMrkdwn(message.name)}*\nZalo ID: \`${message.uid}\``;
      await slack.chat.postMessage({
        channel: channelId,
        text,
      });
      break;
    }

    case 'bankcard': {
      let caption = `${prefix}:bank: *Bank Account*`;
      if (message.bankName) caption += `\nBank: *${escapeSlackMrkdwn(message.bankName)}*`;
      if (message.accountNumber) caption += `\nAccount: \`${message.accountNumber}\``;
      if (message.holderName) caption += `\nHolder: *${escapeSlackMrkdwn(message.holderName)}*`;

      await slack.files.uploadV2({
        channel_id: channelId,
        file: message.qrBuffer,
        filename: 'vietqr.png',
        initial_comment: caption,
      });
      break;
    }
  }
}