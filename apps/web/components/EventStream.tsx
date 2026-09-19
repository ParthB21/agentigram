'use client';

import { useEffect, useRef, useState } from 'react';
import {
  applyFrame,
  DEFAULT_COORDINATOR_URL,
  initialStream,
  roomSocketUrl,
} from '../lib/room-stream';

/** M0 dashboard shell: connects to the coordinator as a dashboard and prints the raw stream. */
export function EventStream({ teamId }: { teamId: string }) {
  const [state, setState] = useState(initialStream);
  const lastSeq = useRef(0);
  lastSeq.current = state.lastSeq;

  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_COORDINATOR_URL ?? DEFAULT_COORDINATOR_URL;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let closed = false;

    const connect = () => {
      socket = new WebSocket(roomSocketUrl(base, teamId));
      socket.onopen = () => {
        attempt = 0;
        socket?.send(
          JSON.stringify({
            type: 'HELLO',
            roomId: teamId,
            lastSeq: lastSeq.current,
            client: 'dashboard',
            token: 'dev',
          }),
        );
      };
      socket.onmessage = (m) => setState((s) => applyFrame(s, String(m.data)));
      socket.onclose = () => {
        if (closed) return;
        setState((s) => ({ ...s, status: 'reconnecting' }));
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15_000));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [teamId]);

  return (
    <main style={{ fontFamily: 'ui-monospace, monospace', padding: 16 }}>
      <h1>Room: {teamId}</h1>
      <p>
        status: <strong>{state.status}</strong> · events: {state.events.length} · last seq:{' '}
        {state.lastSeq}
        {state.error ? ` · ${state.error}` : ''}
      </p>
      <ol style={{ listStyle: 'none', padding: 0, fontSize: 12 }}>
        {state.events.map((e) => (
          <li key={e.seq} style={{ marginBottom: 4 }}>
            <strong>#{e.seq}</strong> {e.payload.type} · {e.actor.sessionId ?? e.actor.engineerId}{' '}
            <code>{JSON.stringify(e.payload)}</code>
          </li>
        ))}
      </ol>
    </main>
  );
}
