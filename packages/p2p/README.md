# @agentigram/p2p

Encrypted laptop-to-laptop transport for Agentigram.

- Hyperswarm discovers the authority and provides Noise-encrypted connections.
- Protomux carries validated Agentigram control messages.
- Corestore replicates the authority's single-writer Hypercore event history.
- `agentigram://join/...` invites contain the repository fingerprint, authority and event-core keys,
  and a 256-bit room capability.

Peers never elect a new writer. When the authority disconnects, `P2PRoomTransport` reports
`read-only` and rejects submissions until it reconnects.
