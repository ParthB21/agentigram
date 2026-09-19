import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapability, P2PRoomTransport, type TransportStatus } from '@agentigram/p2p';
import { symbolKey } from '@agentigram/protocol';
import { AuthorityTransport } from './authority-transport.js';
import type { InstallState } from './install.js';

const CONNECT_TIMEOUT_MS = 20_000;

export async function runLocalDemo(peerCount: number): Promise<{
  peers: number;
  eventTypes: string[];
  leaseDenied: boolean;
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
  authority.onEvents((events) => eventTypes.push(...events.map((event) => event.payload.type)));
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
    await authority.submit({
      id: crypto.randomUUID(),
      roomId: 'demo',
      actor: { engineerId: 'demo-authority', sessionId: 'backend', kind: 'agent' },
      source: 'mcp',
      payload: {
        type: 'INTENT',
        task: 'Change User.id to UUID',
        files: ['src/types/user.ts'],
        symbols: [userId],
      },
    });
    await authority.submit({
      id: crypto.randomUUID(),
      roomId: 'demo',
      actor: { engineerId: 'demo-authority', sessionId: 'backend', kind: 'agent' },
      source: 'mcp',
      payload: { type: 'LEASE_REQUESTED', symbols: [userId], ttlMs: 600_000 },
    });
    const payments = peers[0];
    if (!payments) throw new Error('payments peer is missing');
    await payments.submit({
      id: crypto.randomUUID(),
      roomId: 'demo',
      actor: { engineerId: 'demo-peer', sessionId: 'payments', kind: 'agent' },
      source: 'hook',
      payload: { type: 'FILE_READ', path: 'src/types/user.ts', symbols: [userId] },
    });
    await payments.submit({
      id: crypto.randomUUID(),
      roomId: 'demo',
      actor: { engineerId: 'demo-peer', sessionId: 'payments', kind: 'agent' },
      source: 'mcp',
      payload: { type: 'LEASE_REQUESTED', symbols: [userId], ttlMs: 600_000 },
    });
    return {
      peers: peerCount,
      eventTypes,
      leaseDenied: eventTypes.includes('LEASE_DENIED'),
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
