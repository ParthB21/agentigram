'use client';

import { useEffect, useRef, useState } from 'react';
import {
  applyFrame,
  DEFAULT_COORDINATOR_URL,
  initialStream,
  roomSocketUrl,
  type StreamState,
} from './room-stream';

const MAX_RECONNECT_DELAY_MS = 15_000;

export function useRoomStream(teamId: string): StreamState {
  const [state, setState] = useState(() => initialStream(teamId));
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
      socket.onmessage = (message) =>
        setState((current) => applyFrame(current, String(message.data)));
      socket.onclose = () => {
        if (closed) return;
        setState((current) => ({ ...current, status: 'reconnecting' }));
        const delay = Math.min(1_000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
        attempt += 1;
        retry = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [teamId]);

  return state;
}
