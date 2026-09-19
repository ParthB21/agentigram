'use strict';

const { test } = require('brittle');
const net = require('bare-net');
const os = require('bare-os');
const path = require('bare-path');
const process = require('bare-process');
const { style } = require('bare-tui');
const Daemon = require('../lib/daemon.js');
const Inference = require('../lib/inference.js');
const Narrator = require('../lib/narrator.js');
const {
  buildExplanationRequest,
  finalizeExplanation,
  sanitizePresentationEvent,
} = require('../lib/prompt.js');
const { App } = require('../ui/app.js');

function projected(overrides = {}) {
  return {
    seq: 8,
    sourceSeqs: [7, 8],
    type: 'COLLISION',
    actor: 'backend',
    facts: { tier: 'PREDICTED', detail: 'checkout reads the old identifier' },
    fallback: 'Predicted collision: checkout reads the old identifier.',
    ...overrides,
  };
}

function fakeInference() {
  const calls = { asked: [], cancelled: [] };
  return {
    calls,
    ask(history) {
      calls.asked.push(history);
      return calls.asked.length;
    },
    cancel(id) {
      calls.cancelled.push(id);
    },
  };
}

function drive(app, messages) {
  for (const message of messages) {
    const [next, command] = app.update(message);
    app = next;
    if (typeof command === 'function') command();
  }
  return app;
}

const resize = { type: 'resize', width: 80, height: 24 };
const keyMessage = (name) => ({
  type: 'key',
  name,
  sequence: '',
  is: (...names) => names.includes(name),
});

test('event-to-prompt is compact, redacted, and source grounded', (t) => {
  const request = buildExplanationRequest([
    projected({
      facts: {
        detail: 'token=top-secret and sk-example123456',
        ignored: ['a', 'b'],
      },
    }),
  ]);
  t.ok(request, 'request was built');
  const serialized = JSON.stringify(request.history);
  t.ok(serialized.includes('token=[REDACTED]'), 'key-value secret is redacted');
  t.ok(serialized.includes('sk-[REDACTED]'), 'provider secret is redacted');
  t.absent(serialized.includes('top-secret'), 'raw secret is absent');
  t.alike(request.sourceSeqs, [7, 8], 'source sequence set is retained');
});

test('generated text gets authoritative citations and cannot forge sequences', (t) => {
  const request = buildExplanationRequest([projected()]);
  const final = finalizeExplanation('According to event #999, checkout may break.', request);
  t.ok(final.startsWith('[source #7, #8]'), 'host attaches the source sequences');
  t.absent(final.includes('#999'), 'model-authored sequence is removed');
});

test('invalid presentation events never reach the model prompt', (t) => {
  t.is(sanitizePresentationEvent({ seq: -1 }), null);
  t.is(buildExplanationRequest([{ seq: 1, sourceSeqs: [] }]), null);
});

test('narrator cancels superseded work and drops stale frames', (t) => {
  const inference = fakeInference();
  const narrator = new Narrator(inference);
  const first = narrator.start([projected()]).started;
  const secondResult = narrator.start([projected({ seq: 10, sourceSeqs: [10] })]);
  t.alike(inference.calls.cancelled, [first.id], 'old QVAC request was cancelled');
  t.ok(secondResult.superseded.fallback, 'superseded request resolves with fallback');
  t.is(narrator.delta(first.id, 'GHOST'), null, 'late delta is ignored');
  narrator.delta(secondResult.started.id, 'Current explanation.');
  const final = narrator.finish(secondResult.started.id);
  t.ok(final.text.includes('[source #10]'), 'current request completes with grounding');
});

test('cancel and worker failure both provide deterministic fallback text', (t) => {
  const inference = fakeInference();
  const narrator = new Narrator(inference);
  const started = narrator.start([projected()]).started;
  const cancelled = narrator.cancel();
  t.is(cancelled.id, started.id);
  t.ok(cancelled.text.includes('Predicted collision'));
  t.alike(inference.calls.cancelled, [started.id]);

  const failedId = narrator.start([projected()]).started.id;
  const failed = narrator.fail(failedId);
  t.ok(failed.fallback);
  t.ok(failed.text.includes('[source #7, #8]'));
});

test('inference framed messages preserve request IDs', (t) => {
  const inference = new Inference({ model: 'fake' });
  const seen = [];
  inference.on('delta', (id, text) => seen.push(['delta', id, text]));
  inference.on('end', (id, reason) => seen.push(['end', id, reason]));
  inference._onmessage({ toString: () => JSON.stringify({ t: 'delta', id: 4, text: 'hello' }) });
  inference._onmessage({ toString: () => JSON.stringify({ t: 'end', id: 4, stopReason: 'eos' }) });
  inference._onmessage({ toString: () => 'not-json' });
  t.alike(seen, [
    ['delta', 4, 'hello'],
    ['end', 4, 'eos'],
  ]);
});

test('daemon worker reads the local socket or named pipe with framed JSON', async (t) => {
  const endpoint =
    os.platform() === 'win32'
      ? `\\\\.\\pipe\\agentigram-pear-test-${process.pid}`
      : path.join(os.tmpdir(), `agentigram-pear-test-${process.pid}.sock`);
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.once('data', (raw) => {
      const request = JSON.parse(raw.trim());
      t.alike(request, { type: 'presentation', afterSeq: 0 });
      socket.end(
        `${JSON.stringify({
          ok: true,
          output: {
            roomId: 'test-room',
            transport: 'connected',
            headSeq: 8,
            events: [projected()],
          },
        })}\n`,
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });

  const daemon = new Daemon({ socket: endpoint, room: 'test-room', root: '.' });
  const snapshot = new Promise((resolve, reject) => {
    daemon.once('snapshot', resolve);
    daemon.once('error', reject);
  });
  await daemon.ready();
  const value = await snapshot;
  t.is(value.transport, 'connected');
  t.is(value.events[0].seq, 8);
  await daemon.close();
  await new Promise((resolve) => server.close(resolve));
});

test('bare-tui state ignores stale explanations and fits the terminal', (t) => {
  let cancelled = false;
  let app = new App({
    model: 'fake',
    onCancel: () => {
      cancelled = true;
      return { id: 2, text: '[source #2] fallback', fallback: true };
    },
  });
  app = drive(app, [
    resize,
    { type: 'qvac.loaded', model: 'fake' },
    { type: 'explanation.started', id: 2, sourceSeqs: [2] },
    { type: 'explanation.delta', id: 1, text: 'GHOST' },
  ]);
  t.absent(style.stripAnsi(app.view()).includes('GHOST'), 'stale UI delta is absent');
  app = drive(app, [keyMessage('esc')]);
  t.ok(cancelled, 'escape cancels local inference');
  t.ok(style.stripAnsi(app.view()).includes('fallback'), 'fallback is visible');
  t.is(style.height(app.view()), 24, 'view is exactly terminal height');
});
