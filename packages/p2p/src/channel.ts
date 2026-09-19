import type { Duplex } from 'node:stream';
import c from 'compact-encoding';
import Protomux from 'protomux';

export const CONTROL_PROTOCOL = 'agentigram/control/1';

export type ControlChannel = {
  send(value: string): boolean;
  close(): void;
};

export function openControlChannel(
  socket: Duplex,
  handshake: string,
  receive: (value: string, remoteHandshake: string) => void,
  closed: () => void,
): ControlChannel {
  const mux = Protomux.from(socket);
  let remoteHandshake = '';
  const channel = mux.createChannel({
    protocol: CONTROL_PROTOCOL,
    unique: true,
    handshake: c.string,
    onopen(value: string) {
      remoteHandshake = value;
    },
    onclose: closed,
  });
  if (!channel) throw new Error('control channel could not be created');
  const message = channel.addMessage({
    encoding: c.string,
    onmessage(value: string) {
      receive(value, remoteHandshake);
    },
  });
  channel.open(handshake);
  return { send: (value) => message.send(value), close: () => channel.close() };
}
