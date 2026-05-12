export function truncate(text: string, max = 40000): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function escapeSlackMrkdwn(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function applyMentionsMrkdwn(
  text: string,
  mentions: ReadonlyArray<{ pos: number; len: number; type: number }>,
): string {
  if (!mentions.length) return escapeSlackMrkdwn(text);

  const sorted = [...mentions].sort((a, b) => a.pos - b.pos);
  let result = '';
  let cursor = 0;

  for (const m of sorted) {
    if (m.pos < cursor || m.pos >= text.length) continue;
    if (m.pos > cursor) result += escapeSlackMrkdwn(text.slice(cursor, m.pos));
    const span = text.slice(m.pos, m.pos + m.len);
    result += `*${escapeSlackMrkdwn(span)}*`;
    cursor = m.pos + m.len;
  }

  if (cursor < text.length) result += escapeSlackMrkdwn(text.slice(cursor));
  return result;
}

export function formatGroupMrkdwn(senderName: string, content: string): string {
  return `*${escapeSlackMrkdwn(truncate(senderName, 64))}:*\n${escapeSlackMrkdwn(truncate(content))}`;
}

export function formatGroupMrkdwnHtml(senderName: string, bodyMrkdwn: string): string {
  return `*${escapeSlackMrkdwn(truncate(senderName, 64))}:*\n${bodyMrkdwn}`;
}

export function channelCaption(senderName: string): string {
  return `*${escapeSlackMrkdwn(truncate(senderName, 64))}*\n`;
}

export function topicName(name: string, type: 0 | 1): string {
  return `${type === 1 ? '👥' : '👤'} ${name}`.slice(0, 80);
}