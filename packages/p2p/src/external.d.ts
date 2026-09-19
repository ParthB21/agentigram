declare module 'hyperswarm' {
  import type { Duplex } from 'node:stream';

  export type PeerInfo = { publicKey: Uint8Array; server: boolean; topics: Uint8Array[] };
  export type Discovery = { flushed(): Promise<void>; destroy(): Promise<void> };

  export default class Hyperswarm {
    readonly keyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
    readonly connections: Set<Duplex>;
    on(event: 'connection', listener: (socket: Duplex, peerInfo: PeerInfo) => void): this;
    join(
      topic: Uint8Array,
      options?: { server?: boolean; client?: boolean; limit?: number },
    ): Discovery;
    joinPeer(publicKey: Uint8Array): void;
    destroy(): Promise<void>;
  }
}

declare module 'corestore' {
  import type { Duplex } from 'node:stream';

  export type Core<T> = {
    readonly key: Uint8Array;
    readonly length: number;
    ready(): Promise<void>;
    append(value: T | readonly T[]): Promise<unknown>;
    get(index: number): Promise<T | null>;
    on(event: 'append', listener: () => void): this;
  };

  export default class Corestore {
    constructor(storage: string);
    get<T>(options: { name?: string; key?: Uint8Array; valueEncoding?: unknown }): Core<T>;
    replicate(socket: Duplex): unknown;
    close(): Promise<void>;
  }
}

declare module 'protomux' {
  import type { Duplex } from 'node:stream';

  type Channel = {
    addMessage<T>(options: { encoding: unknown; onmessage(value: T): void }): {
      send(value: T): boolean;
    };
    open(handshake?: unknown): void;
    close(): void;
  };

  export default class Protomux {
    static from(stream: Duplex | Protomux): Protomux;
    createChannel<T>(options: {
      protocol: string;
      unique?: boolean;
      handshake?: unknown;
      onopen?(handshake: T): void;
      onclose?(): void;
    }): Channel | null;
  }
}
