// biome-ignore lint/suspicious/noRedundantUseStrict: loaded as a classic browser script.
'use strict';

// The control window.
//
// It renders the room and nothing else: no daemon socket, no Node APIs, no
// model. Frames arrive over the preload bridge — `{ t: 'state' }` for the room
// as it stands and `{ t: 'event' }` for one line of history — and everything
// here is a pure function of the latest of those.
//
// The negotiation it shows is the one the Bare/Pear TUI produced: that process
// owns QVAC and publishes its contract into the room, which is what reaches
// this window. Sending a proposal stays in the TUI, behind a keypress.

const MAX_FEED = 300;

const el = {
  room: document.getElementById('room'),
  mode: document.getElementById('mode'),
  link: document.getElementById('link'),
  counts: document.getElementById('counts'),
  agents: document.getElementById('agents'),
  collision: document.getElementById('collision'),
  feed: document.getElementById('feed'),
};

let feed = [];
const seen = new Set();

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

// ── header ─────────────────────────────────────────────────────────────────

function renderHeader(state) {
  el.room.textContent = `agentigram · ${state.roomId ?? 'room'}`;
  el.mode.textContent = state.mode ?? '';
  el.mode.hidden = !state.mode;

  const connected = state.transport === 'connected';
  el.link.textContent = connected ? 'connected' : (state.transport ?? 'offline');
  el.link.className = `chip ${connected ? 'ok' : 'bad'}`;

  const s = state.summary;
  el.counts.textContent = s
    ? `${s.activeSessions}/${s.sessions} active · ${s.openCollisions} open · ${s.activeLeases} leases`
    : '';
}

// ── agents ─────────────────────────────────────────────────────────────────

function renderAgents(state) {
  const agents = state.agents ?? [];
  el.agents.replaceChildren();
  if (agents.length === 0) {
    el.agents.append(text('li', 'empty', 'No agents have joined yet.'));
    return;
  }

  const leases = state.leases ?? [];
  const activity = state.activity ?? {};
  const presence = state.presence ?? {};
  for (const agent of agents) {
    const held = leases.filter((lease) => lease.sessionId === agent.sessionId).length;
    const here = presence[agent.sessionId] ?? 'live';
    // A laptop that was closed or lost the network never sends SessionEnd, so
    // `stale` (no heartbeat) is what tells you it is gone rather than thinking.
    const gone = here !== 'live' || agent.status === 'ended';
    const busy = gone ? undefined : activity[agent.sessionId];

    const row = text('li', 'agent');
    row.append(text('span', `dot ${busy ? '' : 'idle'}`.trim()));

    const body = text('div');
    const name = text('div', 'agent-name', agent.sessionId);
    if (held > 0) {
      name.append(text('span', 'lease', `  ${held} lease${held > 1 ? 's' : ''}`));
    }
    body.append(name);
    body.append(text('div', 'agent-host', [agent.host, agent.model].filter(Boolean).join(' · ')));

    // What it is doing right now, from the event stream — not the goal it
    // announced once and may long since have finished.
    const doing =
      agent.status === 'ended'
        ? 'left'
        : here === 'stale'
          ? 'offline'
          : busy
            ? busy.what
            : 'idle';
    body.append(text('div', `agent-task${busy ? '' : ' quiet'}`, doing));
    // The announced goal stays as context underneath, while it is still working.
    if (busy && agent.intent?.task && agent.intent.task !== doing) {
      body.append(text('div', 'agent-host', agent.intent.task));
    }
    row.append(body);
    el.agents.append(row);
  }
}

// ── negotiation ────────────────────────────────────────────────────────────

/** `src/types/user.ts#User.id:property` -> `User.id`. */
function symbolName(key) {
  const hash = String(key).indexOf('#');
  if (hash < 0) return String(key);
  const rest = key.slice(hash + 1);
  const colon = rest.lastIndexOf(':');
  return colon < 0 ? rest : rest.slice(0, colon);
}

function renderCollision(state) {
  const open = (state.collisions ?? []).filter((c) => c.status !== 'resolved');
  el.collision.replaceChildren();

  if (open.length === 0) {
    el.collision.className = 'collision empty-state';
    el.collision.append(text('p', 'quiet', 'No open collisions. Everyone is clear.'));
    return;
  }

  el.collision.className = 'collision';
  // Newest first: the one that just happened is the one being talked about.
  const collision = [...open].sort((a, b) => (b.openedSeq ?? 0) - (a.openedSeq ?? 0))[0];

  const head = text('div', 'collision-head');
  const tier = text(
    'span',
    `tier ${collision.tier === 'PREDICTED' ? 'predicted' : 'overlap'}`,
    collision.tier,
  );
  head.append(tier);
  head.append(
    text(
      'span',
      'who',
      `${collision.writerSession} ↔ ${(collision.affectedSessions ?? []).join(', ')}`,
    ),
  );
  const symbols = (collision.symbols ?? []).map(symbolName).join(', ');
  if (symbols) head.append(text('span', 'symbols', symbols));
  el.collision.append(head);

  el.collision.append(text('p', 'detail', collision.detail ?? ''));

  // The contract, once the on-device model has drafted one and the human has
  // sent it. Before that there is a collision but nothing agreed.
  const negotiation = (state.negotiations ?? []).find(
    (n) => n.collisionId === collision.collisionId,
  );
  const contract = negotiation?.contract;
  if (!contract) {
    el.collision.append(
      text('p', 'quiet', 'Waiting for a contract from the local model in the Pear app…'),
    );
    return;
  }

  const list = text('dl', 'contract');
  list.append(text('dt', null, `contract · ${negotiation.state ?? 'proposed'}`));

  const change = text('dd');
  change.append(text('span', null, `${contract.symbol}: ${contract.before}`));
  change.append(text('span', 'arrow', '→'));
  change.append(text('span', null, contract.after));
  list.append(change);

  if (contract.constraint) {
    list.append(text('dt', null, 'constraint'));
    list.append(text('dd', null, contract.constraint));
  }
  if (contract.migration) {
    list.append(text('dt', null, 'migration'));
    list.append(text('dd', null, contract.migration));
  }
  el.collision.append(list);
}

// ── feed ───────────────────────────────────────────────────────────────────

function kindClass(eventType) {
  if (eventType === 'COLLISION') return 'kind collision';
  if (String(eventType).startsWith('LEASE_')) return 'kind lease';
  return 'kind';
}

function renderFeed(freshSeq) {
  el.feed.replaceChildren();
  // Newest at the top: this pane is short and nobody scrolls it during a demo.
  for (const frame of [...feed].reverse()) {
    const row = text('li', `feed-line${frame.seq === freshSeq ? ' fresh' : ''}`);
    row.append(text('span', 'seq', frame.seq != null ? `#${frame.seq}` : ''));
    row.append(text('span', kindClass(frame.eventType), frame.eventType ?? ''));
    row.append(text('span', 'text', frame.text ?? ''));
    el.feed.append(row);
  }
}

// ── frames ─────────────────────────────────────────────────────────────────

function applyState(state) {
  if (!state) return;
  renderHeader(state);
  renderAgents(state);
  renderCollision(state);
}

function applyEvent(frame) {
  // The daemon replays history to a late subscriber, so the same seq can arrive
  // twice; a duplicated line reads like the event happened twice.
  if (frame.seq != null && seen.has(frame.seq)) return;
  if (frame.seq != null) seen.add(frame.seq);
  feed.push(frame);
  if (feed.length > MAX_FEED) feed = feed.slice(-MAX_FEED);
  renderFeed(frame.seq);
}

window.agentigram.subscribeToFrames((frame) => {
  if (!frame || typeof frame !== 'object') return;
  if (frame.t === 'state') applyState(frame.state);
  else if (frame.t === 'event') applyEvent(frame);
});

// Only fires while the stream is down; it is how the window says the daemon
// has gone away rather than freezing on its last good frame.
window.agentigram.subscribeToEvents((state) => applyState(state));
