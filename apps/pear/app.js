'use strict';

// Modified from hello-pear-qvac-tui/app.js (Apache-2.0).
// The updater stays in its own PearRuntime worker and never replaces a live binary
// until the user explicitly applies the staged update.
const FramedStream = require('framed-stream');
const PearRuntime = require('pear-runtime');
const ReadyResource = require('ready-resource');

module.exports = class App extends ReadyResource {
  constructor({ dir, app, updates, version, upgrade, name }) {
    super();
    Object.assign(this, { dir, app, updates, version, upgrade, name });
    this.IPC = null;
    this.pipe = null;
    this.nextVersion = null;
    this._applying = null;
  }

  _open() {
    this.IPC = PearRuntime.run(require.resolve('./workers/main.js'), [
      String(this.updates),
      this.version,
      this.upgrade,
      this.name,
      this.dir,
      this.app || '',
    ]);
    this.pipe = new FramedStream(this.IPC);
    this.pipe.on('data', (data) => this._onmessage(data.toString()));
    this.pipe.on('error', (error) => this.emit('error', error));
    this.IPC.on('error', (error) => this.emit('error', error));
  }

  _close() {
    this.pipe?.destroy();
    this.IPC?.destroy();
    this.pipe = null;
    this.IPC = null;
  }

  _onmessage(message) {
    if (message === 'updating' || message === 'updated') {
      this.emit(message);
    } else if (message === 'pear:updateApplied') {
      this._applying?.resolve();
      this._applying = null;
      this.emit('update-applied');
    } else if (message.startsWith('pear:updateFailed')) {
      const error = new Error(message.slice('pear:updateFailed'.length).trim() || 'update failed');
      this._applying?.reject(error);
      this._applying = null;
      this.emit('error', error);
    } else {
      this.emit('message', message);
    }
  }

  applyUpdate() {
    if (this._applying) return this._applying.promise;
    if (this.pipe === null) return Promise.reject(new Error('updater worker is not running'));
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this._applying = { promise, resolve, reject };
    this.pipe.write('pear:applyUpdate');
    return promise;
  }
};
