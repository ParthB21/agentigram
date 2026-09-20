import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapability, P2PRoomTransport, type TransportStatus } from '@agentigram/p2p';
import {
  emptyRoomState,
  type Event,
  type RoomState,
  symbolKey,
  type NewEvent,
} from '@agentigram/protocol';
import { reduce } from '@agentigram/reducer';
import { AuthorityTransport } from './authority-transport.js';
import type { InstallState } from './install.js';
import type { Plan } from './orchestrator/plan.js';
import { Planner } from './orchestrator/planner.js';

const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Collisions are announced by the authority in reaction to an event it has just
 * reduced, so they land a tick after the write that caused them. Give the
 * publish a moment before reporting what the room saw.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

/**
 * A whole room on one laptop: real Hyperswarm peers, real detection, real allocation.
 *
 * The script is the canonical scenario with nothing hand-declared. Payments reads `user.ts` and
 * `checkout.ts`; Backend edits `user.ts` and says nothing about it. From that alone the
 * orchestrator has to work out who owns what, take the lease, and tell Payments to stay off — and
 * the intent it announces for Backend is what turns Backend's next write into a tier-1 collision
 * rather than a shrug about two agents being in one file.
 */
export async function runLocalDemo(peerCount: number): Promise<{
  peers: number;
  eventTypes: string[];
  leaseDenied: boolean;
  collisionDetected: boolean;
  plan: Plan | undefined;
}> {
  if (!Number.isInteger(peerCount) || peerCount < 2 || peerCount > 8) {
    throw new Error('--peers must be an integer between 2 and 8');
  }
  const directory = mkdtempSync(join(tmpdir(), 'agentigram-demo-'));
  const authorityState: InstallState = {
    version: 2,
    root: directory,
    roomId: 'demo',
    mode: 'authority',
    host: 'claude-code',
    sessionId: 'backend',
    repositoryFingerprint: 'local-demo',
    p2pStorage: join(directory, 'authority'),
    capability: createCapability(),
    engineerId: 'demo-authority',
    socketPath: join(directory, 'authority.sock'),
    files: {},
    createdDirectories: [],
    claudeConfigPath: join(directory, 'claude.json'),
  };
  const authority = new AuthorityTransport(authorityState);
  const peers: P2PRoomTransport[] = [];
  const eventTypes: string[] = [];
  // Keep the events themselves, not just their types: the write below has to
  // carry the fencing token from Backend's own lease, exactly as the daemon's
  // `attachFencingToken` does for a real hook.
  const seen: Event[] = [];
  // The room as the authority sees it, rebuilt exactly as a daemon does, so the planner reasons
  // over the same state a real laptop would hold.
  let roomState: RoomState = emptyRoomState('demo');
  authority.onEvents((events) => {
    seen.push(...events);
    eventTypes.push(...events.map((event) => event.payload.type));
    for (const event of events) {
      if (event.seq > roomState.lastSeq) roomState = reduce(roomState, event).state;
    }
  });
  const planner = new Planner(
    {
      roomId: 'demo',
      engineerId: 'demo-authority',
      state: () => roomState,
      submit: (event: NewEvent) => authority.submitAsAuthority(event),
      log: { info: () => {}, warn: () => {} },
    },
    // The demo prints a plan rather than speaking one, so there is nothing to pace.
    { pace: async () => {}, minIntervalMs: 0, debounceMs: 0 },
  );
  try {
    await authority.start();
    const invite = authority.invite;
    if (!invite) throw new Error('authority did not create an invite');
    for (let index = 1; index < peerCount; index += 1) {
      const sessionId = index === 1 ? 'payments' : `agent-${index + 1}`;
      const peer = new P2PRoomTransport({
        invite,
        storage: join(directory, sessionId),
        client: 'daemon',
        clientId: sessionId,
        sessionId,
      });
      peers.push(peer);
      const connected = waitForStatus(peer, 'connected');
      await peer.start();
      await connected;
    }
    await authority.submit(sessionStarted('demo', 'backend', 'claude-code'));
    for (let index = 0; index < peers.length; index += 1) {
      const sessionId = index === 0 ? 'payments' : `agent-${index + 2}`;
      await peers[index]?.submit(sessionStarted('demo', sessionId, 'codex'));
    }
    const userId = symbolKey('src/types/user.ts', 'User', 'id', 'property');
    const payments = peers[0];
    if (!payments) throw new Error('payments peer is missing');
    // Payments is reading around the codebase. Nobody has announced anything.
    for (const path of ['src/types/user.ts', 'src/checkout.ts']) {
      await payments.submit({
        id: crypto.randomUUID(),
        roomId: 'demo',
        actor: { engineerId: 'demo-peer', sessionId: 'payments', kind: 'agent' },
        source: 'hook',
        payload: {
          type: 'FILE_READ',
          path,
          ...(path === 'src/types/user.ts' ? { symbols: [userId] } : {}),
        },
      });
    }
    // Backend edits the same file. With no declared intent this is only tier 0 — two agents in
    // one file, which is not worth stopping either of them for.
    await authority.submit({
      id: crypto.randomUUID(),
      roomId: 'demo',
      actor: { engineerId: 'demo-authority', sessionId: 'backend', kind: 'agent' },
      source: 'hook',
      payload: { type: 'FILE_WRITE', path: 'src/types/user.ts', worktree: directory },
    });
    await settle();

    // The orchestrator reads the room and allocates it: Backend keeps `user.ts` because it is the
    // one writing it, Payments keeps `checkout.ts`, and the lease behind that decision is what the
    // PreToolUse hook enforces on every laptop.
    await planner.replan();
    await settle();

    // Payments now wants the file it was told to leave alone. The lease says no.
    await payments.submit({
      id: crypto.randomUUID(),
      roomId: 'demo',
      actor: { engineerId: 'demo-peer', sessionId: 'payments', kind: 'agent' },
      source: 'mcp',
      payload: { type: 'LEASE_REQUESTED', symbols: [userId], ttlMs: 600_000 },
    });
    // Backend writes again. This time the room knows what Backend intends, because the
    // orchestrator announced it, so the write narrows to `User.id` — which Payments has read.
    const granted = seen.find(
      (event) =>
        event.payload.type === 'LEASE_GRANTED' &&
        (event.payload.sessionId ?? event.actor.sessionId) === 'backend',
    );
    const fencingToken =
      granted?.payload.type === 'LEASE_GRANTED' ? granted.payload.fencingToken : undefined;
    await authority.submit({
      id: crypto.randomUUID(),
      roomId: 'demo',
      actor: { engineerId: 'demo-authority', sessionId: 'backend', kind: 'agent' },
      source: 'hook',
      payload: {
        type: 'FILE_WRITE',
        path: 'src/types/user.ts',
        worktree: directory,
        ...(fencingToken === undefined ? {} : { fencingToken }),
      },
    });
    await settle();
    return {
      peers: peerCount,
      eventTypes,
      leaseDenied: eventTypes.includes('LEASE_DENIED'),
      collisionDetected: seen.some(
        (event) => event.payload.type === 'COLLISION' && event.payload.tier === 'PREDICTED',
      ),
      plan: planner.plan,
    };
  } finally {
    await Promise.allSettled(peers.map((peer) => peer.stop()));
    await authority.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

function sessionStarted(roomId: string, sessionId: string, host: string) {
  return {
    id: crypto.randomUUID(),
    roomId,
    actor: { engineerId: sessionId, sessionId, kind: 'agent' as const },
    source: 'hook' as const,
    payload: {
      type: 'SESSION_STARTED' as const,
      sessionId,
      host,
      model: host === 'codex' ? 'gpt' : 'claude',
      branch: 'main',
    },
  };
}

function waitForStatus(transport: P2PRoomTransport, expected: TransportStatus): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for P2P status ${expected}`)),
      CONNECT_TIMEOUT_MS,
    );
    const unsubscribe = transport.onStatus((status) => {
      if (status !== expected) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}
