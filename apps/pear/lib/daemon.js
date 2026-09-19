'use strict';

const FramedStream = require('framed-stream');
const PearRuntime = require('pear-runtime');
const ReadyResource = require('ready-resource');

module.exports = class Daemon extends ReadyResource {
  constructor({ root, socket, room, pollMs = 750, gracePeriod = 1500 } = {}) {
    super();
    this.root = root || '.';
    this.socket = socket || '';
    this.room = room || '';
    this.pollMs = pollMs;
    this.gracePeriod = gracePeriod;
    this.IPC = null;
    this.pipe = null;
    this._onclosed = null;
    this._closed = new Promise((resolve) => {
      this._onclosed = resolve;
    });
  }

  _open() {
    this.IPC = PearRuntime.run(require.resolve('../workers/daemon.js'), [
      this.root,
      this.socket,
      this.room,
      String(this.pollMs),
    ]);
    this.pipe = new FramedStream(this.IPC);
    this.pipe.on('data', (data) => this._onmessage(data));
    this.pipe.on('error', (error) => this.emit('error', error));
    this.IPC.on('error', (error) => this.emit('error', error));
  }

  async _close() {
    const pipe = this.pipe;
    const IPC = this.IPC;
    if (pipe !== null) {
      pipe.write(JSON.stringify({ t: 'close' }));
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
    if (message.t === 'snapshot') this.emit('snapshot', message.snapshot);
    else if (message.t === 'error') this.emit('daemon-error', message.message);
    else if (message.t === 'closed') this._onclosed?.();
  }
};

function timeout(ms) {
  let timer = null;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}
