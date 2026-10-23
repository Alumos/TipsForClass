export interface Target { studentId: string; name: string; className: string; studentNoSuffix: string }
export interface Message {
  id: string;
  revision: number;
  type: 'call' | 'batch' | 'notice';
  title: string;
  body: string;
  destination?: string;
  targets: Target[];
  teacherName: string;
  priority: number;
  startAt: string;
  expireAt: string;
  createdAt: string;
  status: 'active' | 'revoked';
  displayPosition?: DisplayPosition;
  /** 这条提醒在大屏上停留多少分钟，默认 1。 */
  displayMinutes?: number;
  speechText: string;
  broadcast: null | { generation: number; times: number; notBefore: string; deadlineAt: string };
}
export interface Settings { timezone: string; quietHours: { days: number[]; start: string; end: string }[]; configRevision: number }
export type DisplayPosition = 'top_right' | 'center';
export interface DisplaySettings { displayPosition: DisplayPosition; pinnedMessageIds: string[]; revision: number }
export interface Snapshot {
  syncEpoch: string;
  protocolVersion: number;
  watermark: string;
  serverTime: string;
  class: { id: string; name: string };
  settings: Settings;
  displaySettings?: DisplaySettings;
  messages: Message[];
}
export interface WireEvent { event: string; seq?: string; syncEpoch: string; protocolVersion: number; serverTime: string; data: any }
export type Receipt = { messageId: string; revision: number; kind: 'delivery'; state: 'received' | 'displayed' | 'revoked' | 'expired' | 'suppressed' } | { messageId: string; generation: number; round: number; kind: 'broadcast'; status: 'played' | 'skipped' | 'failed'; reason?: string };
export interface Ledger { state: 'playing' | 'played' | 'skipped' | 'failed'; messageId: string; generation: number; round: number; reason?: string }
export interface Saved { apiBase: string; installationId: string; label: string; deviceToken?: string; snapshot?: Snapshot; lastAppliedSeq: string; ledger: Record<string, Ledger>; receipts: Receipt[]; receiptKeys: string[]; pin?: { salt: string; hash: string }; displayId?: number; muted?: boolean; alertedIds?: string[] }
export interface Store { load(): Promise<Saved | null>; save(value: Saved): Promise<void> }
export interface Speech { status(): string; play(text: string): Promise<void>; stop(): void }
export interface ViewState {
  bound: boolean;
  className: string;
  label: string;
  online: boolean;
  live: boolean;
  syncing: boolean;
  lastSync: string;
  error: string;
  ttsStatus: string;
  capability: string;
  messages: Message[];
  now: number;
  quiet: boolean;
  paused: boolean;
  muted: boolean;
  alerts: { id: string; serial: number }[];
  speaking: string | null;
  lastAppliedSeq: string;
  syncEpoch: string;
  apiBase: string;
  pinSet: boolean;
  displayPosition: DisplayPosition;
  /** 这条提醒在大屏上停留多少分钟，默认 1。 */
  displayMinutes?: number;
  pinnedMessageIds: string[];
}
export interface DisplayBridge {
  state(): Promise<ViewState>;
  subscribe(cb: (s: ViewState) => void): () => void;
  bind(input: { apiBase: string; bindCode: string; label: string; pin: string }): Promise<void>;
  unlock(pin: string): Promise<boolean>;
  maintain(action: string, value?: any): Promise<any>;
  displayed(ids: string[]): Promise<void>;
  /** 学生点“已读”后收起提醒，只有桌面外壳实现。 */
  dismiss?(ids: string[]): Promise<void>;
  /** 弹一个自检提醒，用来单独验证提醒窗口链路。 */
  preview?(): Promise<void>;
}
