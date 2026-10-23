import {Engine} from '../core/engine';
import {overlayBounds} from '../core/window';
import {displayPositionFor} from '../core/rules';
import type {DisplayBridge, Message, Saved, Speech, Store, ViewState} from '../core/types';
import {initialState} from '../platform';

/** 只用 Tauri 注入的全局对象，不额外装 npm 依赖。 */
type TauriApi = {
  core: {invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>};
  event: {listen<T>(name: string, handler: (event: {payload: T}) => void): Promise<() => void>};
  window: {getCurrentWindow(): {label: string}};
};

function api(): TauriApi {
  const value = (window as unknown as {__TAURI__?: TauriApi}).__TAURI__;
  if (!value) throw new Error('Tauri 运行时不可用');
  return value;
}

export function currentLabel(): string {
  try {
    return api().window.getCurrentWindow().label;
  } catch {
    return 'main';
  }
}

const STORAGE_KEY = 'classroom-display-v2';
const OVERLAY_MS = 15000;

/** WebView2 的存储落在应用私有目录，等价于原来 sql.js 的位置，省掉一层 Rust 文件读写。 */
const store: Store = {
  async load(): Promise<Saved | null> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Saved) : null;
    } catch {
      return null;
    }
  },
  async save(value: Saved) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  },
};

async function nativeSpeech(): Promise<Speech> {
  const invoke = api().core.invoke;
  let capability = 'unknown';
  try {
    capability = await invoke<string>('speech_status');
  } catch {
    capability = 'windows_adapter_unavailable';
  }
  return {
    status: () => capability,
    play: text => invoke('speech_play', {text}).then(() => undefined),
    stop: () => {
      void invoke('speech_stop').catch(() => undefined);
    },
  };
}

type OverlayPayload = {message: Message; displayPosition: string; className: string};

class TauriBridge implements DisplayBridge {
  private listeners = new Set<(state: ViewState) => void>();
  private overlayId = '';
  private lastSerial = 0;
  private paused = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private engine: Engine) {
    engine.subscribe(state => {
      for (const callback of this.listeners) callback(state);
      void this.drive(state);
    });
    void api().event.listen('classroom-toggle-pause', () => {
      this.paused = !this.paused;
      this.engine.pauseReminders(this.paused);
      if (this.paused) void this.hide();
    });
    // 已绑定设备启动时直接进入托盘待机，不弹设置窗。
    void this.state().then(state => {
      if (state.bound) void api().core.invoke('hide_main').catch(() => undefined);
    });
    void api().event.listen('classroom-settings', () => {
      window.dispatchEvent(new Event('classroom-settings'));
    });
    void api().event.listen<string[]>('overlay-displayed', event => {
      if (this.overlayId) void this.engine.displayed(event.payload).catch(() => undefined);
    });
  }

  state() {
    return this.engine.state();
  }

  subscribe(callback: (state: ViewState) => void) {
    this.listeners.add(callback);
    void this.state().then(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  async bind(input: {apiBase: string; bindCode: string; label: string; pin: string}) {
    await this.engine.bind(input);
    await api().core.invoke('hide_main').catch(() => undefined);
  }

  unlock(pin: string) {
    return this.engine.unlock(pin);
  }

  maintain(action: string, value?: unknown) {
    return this.engine.maintain(action, value);
  }

  displayed(ids: string[]) {
    return this.engine.displayed(ids);
  }

  private async drive(state: ViewState) {
    const current = state.messages.find(message => message.id === this.overlayId);
    if (this.overlayId && !current) return this.hide();
    if (this.overlayId || this.paused || state.paused) return;

    const fresh = state.alerts
      .filter(alert => alert.serial > this.lastSerial)
      .sort((left, right) => right.serial - left.serial);
    if (!fresh.length) return;
    this.lastSerial = Math.max(...fresh.map(alert => alert.serial));
    const message = state.messages.find(item => item.id === fresh[0].id);
    if (!message) return;

    // 用户正在看设置页时不打断；托盘待机时才弹。
    const mainVisible = await api().core.invoke<boolean>('main_visible').catch(() => false);
    if (mainVisible) return;

    const bounds = overlayBounds(
      {x: 0, y: 0, width: window.screen.availWidth, height: window.screen.availHeight},
      displayPositionFor(message, state.displayPosition),
    );
    this.overlayId = message.id;
    await api().core
      .invoke('overlay_show', {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        payload: JSON.stringify({
          message,
          displayPosition: state.displayPosition,
          className: state.className,
        } satisfies OverlayPayload),
      })
      .catch(() => {
        this.overlayId = '';
      });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.hide(), OVERLAY_MS);
  }

  private async hide() {
    clearTimeout(this.timer);
    this.overlayId = '';
    await api().core.invoke('overlay_hide').catch(() => undefined);
  }
}

/** 提醒窗口只渲染一条消息，不需要自己的引擎实例。 */
class OverlayBridge implements DisplayBridge {
  private stateValue: ViewState = {...initialState, messages: []};
  private listeners = new Set<(state: ViewState) => void>();

  constructor() {
    void api().event.listen<OverlayPayload>('overlay-payload', event => this.apply(event.payload));
    // 首次弹窗时页面往往还没加载完，事件会丢，这里补拉一份缓存。
    void api().core
      .invoke<string | null>('overlay_payload')
      .then(raw => {
        if (!raw) return;
        try {
          this.apply(JSON.parse(raw) as OverlayPayload);
        } catch {
          /* 缓存损坏时忽略，等下一次事件 */
        }
      })
      .catch(() => undefined);
  }

  private apply(payload: OverlayPayload) {
    this.stateValue = {
      ...this.stateValue,
      messages: [payload.message],
      displayPosition: payload.displayPosition === 'center' ? 'center' : 'top_right',
      className: payload.className,
      bound: true,
    };
    window.dispatchEvent(
      new CustomEvent('classroom-overlay', {detail: {visible: true, id: payload.message.id}}),
    );
    for (const callback of this.listeners) callback(this.stateValue);
  }

  state() {
    return Promise.resolve(this.stateValue);
  }

  subscribe(callback: (state: ViewState) => void) {
    this.listeners.add(callback);
    callback(this.stateValue);
    return () => {
      this.listeners.delete(callback);
    };
  }

  bind(): Promise<void> {
    return Promise.reject(new Error('提醒窗口不处理绑定'));
  }

  unlock() {
    return Promise.resolve(false);
  }

  maintain() {
    return Promise.resolve(undefined);
  }

  displayed(ids: string[]) {
    return api().core.invoke('overlay_displayed', {ids}).then(() => undefined);
  }

  dismiss(ids: string[]) {
    return api().core.invoke('overlay_dismiss', {ids}).then(() => undefined);
  }
}

export async function createTauriBridge(): Promise<DisplayBridge> {
  if (currentLabel() === 'overlay') return new OverlayBridge();
  const engine = await Engine.create(store, await nativeSpeech(), 'WebView2 · 需在 Windows 上验收焦点与语音');
  return new TauriBridge(engine);
}
