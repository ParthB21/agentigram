'use strict';

// Starter-derived bare-tui Elm model. QVAC and daemon I/O arrive only as messages.
const { key, quit, spinner, style, viewport } = require('bare-tui');

const ACCENT = '#7AA2F7';
const GOOD = '#43E97B';
const WARN = '#F5C2E7';
const MIN_WIDTH = 34;
const MIN_HEIGHT = 10;

class App {
  constructor({ model, version, onCancel, onApplyUpdate } = {}) {
    this.model = model || 'local model';
    this.version = version || '0.0.0';
    this.onCancel = onCancel || null;
    this.onApplyUpdate = onApplyUpdate || null;
    this.width = 80;
    this.height = 24;
    this.phase = 'loading';
    this.percentage = 0;
    this.roomId = 'not connected';
    this.transport = 'connecting';
    this.headSeq = 0;
    this.entries = [];
    this.active = null;
    this.updateReady = false;
    this.body = viewport.create({ width: 0, height: 12 });
    this.spinner = spinner.create({ frames: spinner.dots, fps: 12 });
    this.follow = true;
    this.headerH = 4;
    this.footerH = 3;
  }

  init() {
    return this.spinner.init();
  }

  update(message) {
    switch (message.type) {
      case 'resize':
        this.width = Math.max(MIN_WIDTH, message.width || MIN_WIDTH);
        this.height = Math.max(MIN_HEIGHT, message.height || MIN_HEIGHT);
        this._layout();
        this._sync();
        return [this, null];
      case 'spinner.tick': {
        const [next, command] = this.spinner.update(message);
        this.spinner = next;
        if (this.phase === 'loading' || this.active) this._sync();
        return [this, command];
      }
      case 'qvac.progress':
        this.percentage = Math.max(0, Math.min(100, Number(message.percentage) || 0));
        return [this, null];
      case 'qvac.loaded':
        this.model = message.model || this.model;
        this.phase = this.active ? 'explaining' : 'ready';
        this._note(
          `Local model ${this.model} is ready. Coordination decisions remain deterministic.`,
        );
        this._sync();
        return [this, null];
      case 'qvac.error':
        this.phase = 'fallback';
        this._note(
          `QVAC unavailable; deterministic local explanations remain active. ${message.message}`,
        );
        this._sync();
        return [this, null];
      case 'daemon.snapshot':
        this.roomId = message.snapshot.roomId;
        this.transport = message.snapshot.transport;
        this.headSeq = message.snapshot.headSeq;
        return [this, null];
      case 'daemon.error':
        this.transport = 'unavailable';
        this._note(`Local daemon: ${message.message}`);
        this._sync();
        return [this, null];
      case 'explanation.started':
        this.active = { id: message.id, sourceSeqs: message.sourceSeqs, text: '' };
        this.phase = 'explaining';
        this._sync();
        return [this, null];
      case 'explanation.delta':
        if (this.active?.id !== message.id) return [this, null];
        this.active.text = `${this.active.text}${message.text}`.slice(0, 4000);
        this._sync();
        return [this, null];
      case 'explanation.complete':
        if (this.active !== null && this.active.id !== message.id) return [this, null];
        this.entries.push({ text: message.text, fallback: message.fallback === true });
        this.entries = this.entries.slice(-100);
        if (this.active?.id === message.id) this.active = null;
        this.phase = this.phase === 'fallback' ? 'fallback' : 'ready';
        this._sync();
        return [this, null];
      case 'update.ready':
        this.updateReady = true;
        this._note('A Pear OTA update is staged. Press ctrl+r to apply it, then restart.');
        this._sync();
        return [this, null];
      case 'update.applied':
        this.updateReady = false;
        this._note('Update applied. Restart Agentigram Pear to use it.');
        this._sync();
        return [this, null];
      case 'update.error':
        this._note(`Update failed: ${message.message}`);
        this._sync();
        return [this, null];
      case 'key':
        return this._key(message);
      default:
        return [this, null];
    }
  }

  _key(message) {
    if (key.matches(message, 'pageup', 'pagedown', 'ctrl+u', 'ctrl+d')) {
      this.body.update(message);
      this.follow = this.body.atBottom;
      return [this, null];
    }
    if (key.matches(message, 'esc') && this.active) {
      const completed = this.onCancel?.();
      if (completed) this.update({ type: 'explanation.complete', ...completed });
      return [this, null];
    }
    if (key.matches(message, 'ctrl+r') && this.updateReady) {
      this.onApplyUpdate?.();
      return [this, null];
    }
    if (key.matches(message, 'ctrl+c')) {
      if (this.active) {
        const completed = this.onCancel?.();
        if (completed) this.update({ type: 'explanation.complete', ...completed });
        return [this, null];
      }
      return [this, quit];
    }
    return [this, null];
  }

  _note(text) {
    this.entries.push({ text: String(text), fallback: true });
    this.entries = this.entries.slice(-100);
  }

  _layout() {
    this.headerH = style.height(this._header());
    this.footerH = style.height(this._footer());
    this.body.height = Math.max(1, this.height - this.headerH - this.footerH);
  }

  _sync() {
    const width = Math.max(20, this.width - 6);
    const rows = [];
    for (const entry of this.entries) {
      const label = entry.fallback
        ? style().foreground(WARN).render('LOCAL')
        : style().foreground(GOOD).render('QVAC');
      rows.push(
        `${label}  ${style()
          .width(width - 7)
          .render(entry.text)}`,
      );
      rows.push('');
    }
    if (this.active) {
      const refs = this.active.sourceSeqs.map((seq) => `#${seq}`).join(', ');
      const text = this.active.text.trim() || `${this.spinner.view()} explaining locally…`;
      rows.push(
        `${style().foreground(ACCENT).render(`QVAC ${refs}`)}  ${style()
          .width(width - 12)
          .render(text)}`,
      );
    }
    if (rows.length === 0) rows.push('Waiting for a notable local coordination event…');
    this.body.setContent(rows.join('\n'));
    if (this.follow) this.body.gotoBottom();
  }

  view() {
    return [this._header(), this.body.view(), this._footer()].join('\n');
  }

  _header() {
    const title =
      style().bold(true).foreground(ACCENT).render('◆ Agentigram Local Narrator') +
      style().faint(true).render(`  v${this.version}`);
    const meta = style()
      .faint(true)
      .render(
        `room ${this.roomId}  ·  daemon ${this.transport}  ·  head #${this.headSeq}  ·  ${this.model}`,
      );
    return style()
      .width(this.width - 4)
      .padding(0, 1)
      .border(style.borders.rounded)
      .borderForeground(ACCENT)
      .render(style.joinVertical(style.position.left, title, meta));
  }

  _footer() {
    let status;
    if (this.phase === 'loading')
      status = `${this.spinner.view()} loading model ${this.percentage}%`;
    else if (this.phase === 'explaining')
      status = `${this.spinner.view()} presentation only · esc cancels`;
    else if (this.phase === 'fallback') status = 'deterministic fallback mode';
    else status = 'ready · QVAC output never enters agent context or coordination state';
    const hint = this.updateReady
      ? 'ctrl+r apply update · pgup/pgdn scroll · ctrl+c quit'
      : 'pgup/pgdn scroll · ctrl+c quit';
    return style.joinVertical(
      style.position.left,
      style()
        .foreground(this.phase === 'fallback' ? WARN : GOOD)
        .render(` ${status}`),
      style().faint(true).render(` ${hint}`),
    );
  }
}

module.exports = { App };
