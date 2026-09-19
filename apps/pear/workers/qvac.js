'use strict';

// Modified from hello-pear-qvac-tui/workers/qvac.js (Apache-2.0).
// This worker owns the QVAC SDK and model. The rest of Agentigram never imports QVAC.
const FramedStream = require('framed-stream');
const { isBareKit } = require('which-runtime');

const argv = (index) => Bare.argv[index + (isBareKit ? 0 : 2)];
const modelName = argv(0) || 'SMOLLM2_360M_INST_Q8';
const ctxSize = Number(argv(1)) || 4096;
const verbose = argv(2) === '1';
const pipe = new FramedStream(Bare.IPC);
const send = (message) => pipe.write(JSON.stringify(message));

let sdk = null;
let modelId = null;
let closing = null;
const inflight = new Map();

function log(message) {
  if (!verbose) return;
  try {
    console.error(`[qvac] ${message}`);
  } catch {}
}

async function boot() {
  sdk = await import('@qvac/inference');
  const { llmPlugin } = await import('@qvac/inference/llamacpp-completion/plugin');
  sdk.registerPlugin(llmPlugin);
  const modelSrc = sdk[modelName];
  if (!modelSrc) throw new Error(`Unknown model: ${modelName}`);
  log(`loading ${modelName} with ctx_size=${ctxSize}`);
  modelId = await sdk.loadModel({
    modelSrc,
    modelConfig: { ctx_size: ctxSize, ...(verbose ? { verbosity: 3 } : {}) },
    onProgress: ({ percentage }) => send({ t: 'progress', percentage }),
  });
  send({ t: 'loaded', model: modelName, ctxSize });
}

async function ask(id, history) {
  const run = sdk.completion({ modelId, history, captureThinking: true });
  inflight.set(id, run.requestId);
  try {
    for await (const event of run.events) {
      if (event.type === 'contentDelta') send({ t: 'delta', id, text: event.text });
      else if (event.type === 'thinkingDelta') send({ t: 'thinking', id, text: event.text });
    }
    const final = await run.final;
    send({ t: 'end', id, stopReason: final.stopReason || 'eos' });
  } catch (error) {
    if (error instanceof sdk.InferenceCancelledError) {
      send({ t: 'end', id, stopReason: 'cancelled' });
    } else {
      send({ t: 'error', id, message: error.message });
    }
  } finally {
    inflight.delete(id);
  }
}

function cancel(id) {
  const requestId = inflight.get(id);
  if (requestId) sdk.cancel({ requestId }).catch(noop);
}

function shutdown() {
  if (closing) return closing;
  closing = (async () => {
    try {
      for (const requestId of inflight.values()) await sdk?.cancel({ requestId }).catch(noop);
      if (modelId) await sdk?.unloadModel({ modelId });
      await sdk?.close();
    } catch (error) {
      log(`shutdown warning: ${error.message}`);
    }
    send({ t: 'closed' });
  })();
  return closing;
}

pipe.on('data', (data) => {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (message.t === 'ask') ask(message.id, message.history).catch(noop);
  else if (message.t === 'cancel') cancel(message.id);
  else if (message.t === 'close') shutdown();
});

boot().catch((error) => {
  log(`boot failed: ${error.stack || error.message}`);
  send({ t: 'error', message: error.message });
});

function noop() {}
