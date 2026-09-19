import type { Payload } from '@clankergram/protocol';
import { DEFAULT_COORDINATOR_URL, roomSocketUrl } from './room-stream';

const ACTION_TIMEOUT_MS = 4_000;

export function submitHumanAction(teamId: string, payload: Payload): Promise<void> {
  return new Promise((resolve, reject) => {
    const base = process.env.NEXT_PUBLIC_COORDINATOR_URL ?? DEFAULT_COORDINATOR_URL;
    const socket = new WebSocket(roomSocketUrl(base, teamId));
    const eventId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('Coordinator did not acknowledge the action.'));
    }, ACTION_TIMEOUT_MS);
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: 'HELLO',
          roomId: teamId,
          lastSeq: 0,
          client: 'dashboard',
          token: 'dev',
        }),
      );
    socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data)) as {
        type?: string;
        id?: string;
        message?: string;
      };
      if (frame.type === 'WELCOME') {
        socket.send(
          JSON.stringify({
            type: 'SUBMIT',
            event: {
              id: eventId,
              roomId: teamId,
              actor: { engineerId: 'dashboard-human', kind: 'human' },
              source: 'system',
              payload,
            },
          }),
        );
      }
      if (frame.type === 'ACK' && frame.id === eventId) {
        clearTimeout(timeout);
        socket.close();
        resolve();
      }
      if (frame.type === 'ERROR') {
        clearTimeout(timeout);
        socket.close();
        reject(new Error(frame.message ?? 'Coordinator rejected the action.'));
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error('Coordinator is unavailable.'));
    };
  });
}
