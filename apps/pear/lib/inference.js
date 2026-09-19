'use strict';

// Modified from hello-pear-qvac-tui/lib/inference.js (Apache-2.0).
// It deliberately keeps the starter's PearRuntime worker isolation,
// FramedStream JSON protocol, per-request IDs, cancellation, and close handshake.
const FramedStream = require('framed-stream');
const PearRuntime = require('pear-runtime');
const ReadyResource = require('ready-resource');

module.exports = class Inference extends ReadyResource {
  constructor({ model, ctxSize, gracePeriod, verbose } = {}) {
    super();
    this.model = model || 'SMOLLM2_360M_INST_Q8';
    this.ctxSize = ctxSize || 4096;
    this.gracePeriod = gracePeriod ?? 5000;
    this.verbose = verbose === true;
    this.loaded = false;
    this.percentage = 0;
    this.IPC = null;
    this.pipe = null;
    this._seq = 0;
    this._onclosed = null;
    this._closed = new Promise((resolve) => {
      this._onclosed = resolve;
    });
  }

  _open() {
    this.IPC = PearRuntime.run(require.resolve('../workers/qvac.js'), [
      this.model,
      String(this.ctxSize),
      this.verbose ? '1' : '0',
    ]);
    this.pipe = new FramedStream(this.IPC);
    this.pipe.on('data', (data) => this._onmessage(data));
    this.pipe.on('error', (error) => this.emit('error', error));
    this.IPC.on('error', (error) => this.emit('error', error));
    this.IPC.on('exit', (code) => {
      if (code === 0 || this.closing !== null || this.closed) return;
      this.emit('error', new Error(`Inference worker exited with code ${code}`));
    });
  }

  async _close() {
    const pipe = this.pipe;
    const IPC = this.IPC;
    if (pipe !== null) {
      this._send({ t: 'close' });
      const grace = timeout(this.gracePeriod);
      try {
        await Promise.race([this._closed, grace.promise]);
      } finally {
        grace.clear();
      }
    }
    this.pipe = null;
    this.IPC = null;
    pipe?.destroy();
    IPC?.destroy();
  }

  _onmessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (message.t) {
      case 'progress':
        this.percentage = message.percentage;
        this.emit('progress', message.percentage);
        break;
      case 'loaded':
        this.loaded = true;
        this.ctxSize = message.ctxSize || this.ctxSize;
        this.emit('loaded', message.model, this.ctxSize);
        break;
      case 'thinking':
        this.emit('thinking', message.id, message.text);
        break;
      case 'delta':
        this.emit('delta', message.id, message.text);
        break;
      case 'end':
        this.emit('end', message.id, message.stopReason);
        break;
      case 'closed':
        this._onclosed?.();
        break;
      case 'error':
        this.emit('answer-error', message.id, message.message);
        break;
    }
  }

  ask(history) {
    const id = ++this._seq;
    this._send({ t: 'ask', id, history });
    return id;
  }

  cancel(id) {
    this._send({ t: 'cancel', id });
  }

  _send(message) {
    this.pipe?.write(JSON.stringify(message));
  }
};

function timeout(ms) {
  let timer = null;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}
