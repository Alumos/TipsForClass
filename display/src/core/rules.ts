import type { DisplayPosition, Message, Settings } from './types.js';

export const compareSeq = (a: string, b: string) => {
  const x = BigInt(a || '0');
  const y = BigInt(b || '0');
  return x < y ? -1 : x > y ? 1 : 0;
};
export const isActive = (m: Message, now: number) => m.status === 'active' && Date.parse(m.startAt) <= now && now < Date.parse(m.expireAt);

export function quietAt(settings: Settings | undefined, now: number): boolean {
  if (!settings) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.timezone || 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '';
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  const minute = `${get('hour')}:${get('minute')}`;
  return (settings.quietHours || []).some((q) => q.days.includes(day) && q.start <= minute && minute < q.end);
}

export const speechKey = (epoch: string, id: string, generation: number, round: number) => `${epoch}:${id}:${generation}:${round}`;
export const receiptKey = (r: any) => r.kind === 'delivery' ? `d:${r.messageId}:${r.revision}:${r.state}` : `b:${r.messageId}:${r.generation}:${r.round}`;

export function sortMessages(messages: Message[], pinnedIds: string[] = []): Message[] {
  const pins = new Map(pinnedIds.map((id, index) => [id, index]));
  return [...messages].sort((a, b) => {
    const ap = pins.get(a.id);
    const bp = pins.get(b.id);
    if (ap !== undefined || bp !== undefined) {
      if (ap === undefined) return 1;
      if (bp === undefined) return -1;
      return ap - bp;
    }
    return Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id, undefined, { numeric: true });
  });
}

export function messagePages(messages: Message[]): Message[][] {
  return (messages || []).map((message) => [message]);
}

export const validDisplayPosition = (value: unknown): value is DisplayPosition => value === 'top_right' || value === 'center';

export function displayPositionFor(message: Pick<Message, 'displayPosition'> | undefined, fallback: DisplayPosition = 'top_right'): DisplayPosition {
  return validDisplayPosition(message?.displayPosition) ? message.displayPosition : validDisplayPosition(fallback) ? fallback : 'top_right';
}

export function textPages(text: string, limit = 100): string[] {
  const chars = Array.from(text || '');
  const pages: string[] = [];
  for (let i = 0; i < chars.length; i += limit) pages.push(chars.slice(i, i + limit).join(''));
  return pages.length ? pages : [''];
}

export function legacyDestination(message: Message): string {
  if (message.destination) return message.destination;
  const match = String(message.title || '').match(/(?: · 到 | · )([^·]+)$/);
  if (message.type === 'call' && match) return match[1].trim();
  if (message.type === 'batch' && match) return '';
  return '';
}
