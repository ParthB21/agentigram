const SETTINGS_KEY = 'agentigram.desktop.voice.v1';
const MODES = ['normal', 'lively', 'off'];
const MAX_QUEUE = 8;
const URGENT = 3;

export class SpeechQueue {
  constructor({ onState, onBoundary, onError } = {}) {
    this.onState = onState ?? (() => {});
    this.onBoundary = onBoundary ?? (() => {});
    this.onError = onError ?? (() => {});
    this.queue = [];
    this.seen = new Set();
    this.current = null;
    this.localSession = null;
    this.voiceAll = false;
    this.generation = 0;
    this.settings = loadSettings();
  }

  get supported() {
    return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  }

  get mode() {
    return this.settings.mode;
  }

  get volume() {
    return this.settings.volume;
  }

  setLocalSession(sessionId) {
    this.localSession = sessionId || null;
  }

  setVoiceAll(enabled) {
    this.voiceAll = Boolean(enabled);
  }

  setVolume(volume) {
    this.settings.volume = clamp(Number(volume), 0, 1);
    persist(this.settings);
    window.agentigram
      ?.setVoiceSettings({
        enabled: this.settings.mode !== 'off',
        volume: this.settings.volume,
      })
      .catch(() => {});
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return;
    this.settings.mode = mode;
    persist(this.settings);
    window.agentigram
      ?.setVoiceSettings({
        enabled: mode !== 'off',
        volume: this.settings.volume,
      })
      .catch(() => {});
    if (mode === 'off') this.cancel();
  }

  cycleMode() {
    const index = MODES.indexOf(this.settings.mode);
    this.setMode(MODES[(index + 1) % MODES.length]);
    return this.settings.mode;
  }

  isMuted(sessionId) {
    if (Object.hasOwn(this.settings.muted, sessionId)) return this.settings.muted[sessionId];
    if (sessionId === 'agentigram' || this.voiceAll) return false;
    return Boolean(this.localSession && sessionId !== this.localSession);
  }

  toggleMute(sessionId) {
    const muted = !this.isMuted(sessionId);
    this.settings.muted[sessionId] = muted;
    persist(this.settings);
    if (muted) {
      this.queue = this.queue.filter((item) => item.speaker !== sessionId);
      if (this.current?.speaker === sessionId) this._interrupt();
    }
    this.onState({ speaker: sessionId, state: muted ? 'muted' : 'idle' });
    return muted;
  }

  enqueue({ seq, speaker, text, priority = 0 }) {
    if (!Number.isFinite(seq) || this.seen.has(seq)) return false;
    this.seen.add(seq);
    if (
      this.settings.mode === 'off' ||
      !this.supported ||
      this.isMuted(speaker) ||
      !String(text).trim()
    ) {
      return false;
    }

    const item = {
      seq,
      speaker: String(speaker),
      text: String(text),
      priority: clamp(Math.round(priority), 0, 3),
    };
    this.queue.push(item);
    this._trim();
    if (!this.queue.includes(item)) return false;
    this.onState({ ...item, state: 'queued' });

    if (item.priority >= URGENT && this.current && this.current.priority < URGENT) {
      this._interrupt();
    }
    this._pump();
    return true;
  }

  cancel() {
    for (const item of this.queue) this.onState({ ...item, state: 'idle', cancelled: true });
    this.queue = [];
    this._interrupt();
  }

  close() {
    this.cancel();
  }

  _trim() {
    while (this.queue.length > MAX_QUEUE) {
      let victim = 0;
      for (let index = 1; index < this.queue.length; index += 1) {
        if (this.queue[index].priority < this.queue[victim].priority) victim = index;
      }
      const [removed] = this.queue.splice(victim, 1);
      this.onState({ ...removed, state: 'idle', dropped: true });
    }
  }

  _interrupt() {
    const active = this.current;
    if (!active) return;
    this.generation += 1;
    this.current = null;
    window.speechSynthesis.cancel();
    this.onState({ ...active, state: 'idle', interrupted: true });
    window.setTimeout(() => this._pump(), 30);
  }

  _pump() {
    if (this.current || this.queue.length === 0 || this.settings.mode === 'off') return;

    let best = 0;
    for (let index = 1; index < this.queue.length; index += 1) {
      if (this.queue[index].priority > this.queue[best].priority) best = index;
    }
    const [item] = this.queue.splice(best, 1);
    const generation = ++this.generation;
    this.current = item;
    this.onState({ ...item, state: 'synthesizing' });

    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.volume = this.settings.volume;
    utterance.rate = this.settings.mode === 'lively' ? 1.14 : 1;
    utterance.pitch = 0.9 + stableIndex(item.speaker, 5) * 0.045;
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      const preferred = voices.filter((voice) => /^en(-|_)/i.test(voice.lang));
      const pool = preferred.length > 0 ? preferred : voices;
      utterance.voice = pool[stableIndex(item.speaker, pool.length)] ?? null;
    }

    utterance.onstart = () => {
      if (!this._isCurrent(item, generation)) return;
      this.onState({ ...item, state: 'speaking' });
    };
    utterance.onboundary = (event) => {
      if (!this._isCurrent(item, generation)) return;
      const energy = 0.45 + ((event.charIndex + stableIndex(item.speaker, 17)) % 10) / 18;
      this.onBoundary({ speaker: item.speaker, energy });
    };
    utterance.onend = () => this._finish(item, generation);
    utterance.onerror = (event) => {
      if (!this._isCurrent(item, generation)) return;
      const ignored = event.error === 'interrupted' || event.error === 'canceled';
      if (!ignored)
        this.onError(new Error(`Voice playback failed: ${event.error || 'unknown error'}`));
      this._finish(item, generation, !ignored);
    };

    try {
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
      this._finish(item, generation, true);
    }
  }

  _isCurrent(item, generation) {
    return this.current === item && this.generation === generation;
  }

  _finish(item, generation, failed = false) {
    if (!this._isCurrent(item, generation)) return;
    this.current = null;
    this.onState({ ...item, state: 'idle', failed });
    window.setTimeout(() => this._pump(), 40);
  }
}

function stableIndex(value, length) {
  if (length <= 1) return 0;
  let hash = 0;
  for (const char of String(value)) hash = (hash * 33 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % length;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function loadSettings() {
  const defaults = { mode: 'normal', volume: 0.8, muted: {} };
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!value || typeof value !== 'object') return defaults;
    return {
      mode: MODES.includes(value.mode) ? value.mode : defaults.mode,
      volume: clamp(Number(value.volume ?? defaults.volume), 0, 1),
      muted: value.muted && typeof value.muted === 'object' ? value.muted : {},
    };
  } catch {
    return defaults;
  }
}

function persist(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Voice remains functional when storage is unavailable.
  }
}
