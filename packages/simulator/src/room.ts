import {
  type ClientKind,
  type Event,
  emptyRoomState,
  isAgentVisible,
  type NewEvent,
  type RoomState,
  type ServerMessage,
} from '@agentigram/protocol';
import { type Effect, reduce } from '@agentigram/reducer';

/** One connected client, transport-agnostic so a Room is testable without sockets. */
export type Sink = {
  kind: ClientKind;
  sessionId?: string;
  send(message: ServerMessage): void;
};

export type SubmitResult = { event: Event; duplicate: boolean };

/**
 * One room of the mock coordinator: assigns `seq`, dedupes by client id, runs the real reducer,
 * replays from `lastSeq` on join, and fans out. `seq` is assigned here and nowhere else.
 */
export class Room {
  state: RoomState;
  readonly log: Event[] = [];
  private readonly seen = new Map<string, number>();
  private readonly sinks = new Set<Sink>();
  private lastTs = 0;

  constructor(
    readonly roomId: string,
    private readonly now: () => number = Date.now,
  ) {
    this.state = emptyRoomState(roomId);
  }

  /** WELCOME (state at head), then the gap after `lastSeq` in order. Daemons never get dashboard-only events. */
  join(sink: Sink, lastSeq: number): void {
    sink.send({ type: 'WELCOME', roomState: this.state, fromSeq: lastSeq });
    const gap = this.log.filter((e) => e.seq > lastSeq && this.canSee(sink, e));
    if (gap.length > 0) sink.send({ type: 'EVENTS', events: gap });
    this.sinks.add(sink);
  }

  leave(sink: Sink): void {
    this.sinks.delete(sink);
  }

  submit(input: NewEvent): SubmitResult {
    const prior = this.seen.get(input.id);
    if (prior !== undefined) {
      const event = this.log[prior - 1];
      if (event) return { event, duplicate: true }; // at-least-once in, exactly-once applied
    }
    this.lastTs = Math.max(this.lastTs, this.now());
    const event: Event = {
      ...input,
      roomId: this.roomId,
      seq: this.state.lastSeq + 1,
      ts: new Date(this.lastTs).toISOString(),
    };
    const { state, effects } = reduce(this.state, event);
    this.state = state;
    this.log.push(event);
    this.seen.set(event.id, event.seq);
    this.fanOut(event, effects);
    return { event, duplicate: false };
  }

  private canSee(sink: Sink, event: Event): boolean {
    return sink.kind === 'dashboard' || isAgentVisible(event.payload.type);
  }

  private fanOut(event: Event, effects: Effect[]): void {
    const recipients = new Set<Sink>();
    for (const effect of effects) {
      if (effect.kind !== 'broadcast') continue;
      for (const sink of this.sinks) {
        if (
          effect.to === 'dashboards'
            ? sink.kind === 'dashboard'
            : sink.kind === 'daemon' && !!sink.sessionId && effect.to.includes(sink.sessionId)
        ) {
          recipients.add(sink);
        }
      }
    }
    // Workers analyze every agent-visible event. Session-less daemons are explicit observers.
    for (const sink of this.sinks) {
      if (sink.kind === 'worker' || (sink.kind === 'daemon' && !sink.sessionId))
        recipients.add(sink);
    }
    for (const sink of recipients) {
      if (this.canSee(sink, event)) sink.send({ type: 'EVENTS', events: [event] });
    }
  }
}
