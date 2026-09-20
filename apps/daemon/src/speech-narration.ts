import { basename } from 'node:path';
import { redactPayload } from '@agentigram/adapters';
import type { Event } from '@agentigram/protocol';
import { isPresenceEvent, type SpeechMetadata, speechMetadata } from './event-rendering.js';

/**
 * How long an agent stays quiet after saying what it is working on.
 *
 * A coding agent saves files far faster than a voice can read them out, and a refactor that
 * narrated every write would evict the negotiation from an eight-line queue. One line, then
 * silence, then one line that accounts for everything saved in between.
 */
export const WRITE_COOLDOWN_MS = 8_000;

/**
 * How long an arrival or a departure stays said.
 *
 * A session announces itself on every reconnect and ends twice whenever its own farewell is
 * followed by the authority noticing the socket close, so the same sentence can arrive two or
 * three times within a second. Saying it once is the whole rule: a genuine rejoin minutes later
 * is news again, and is spoken again.
 */
export const REPEAT_WINDOW_MS = 30_000;

/** Beyond this many, a person says "and two other files" rather than reciting a list. */
const MAX_NAMED = 2;

/**
 * Varied so a long session does not sound like a progress bar, and indexed by the event's own
 * sequence number so the wording is reproducible rather than random.
 */
const VERBS = ['Updating', 'Editing', 'Working on', 'Changing'];
const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/**
 * Everything the daemon says that depends on what it has already said.
 *
 * `speechMetadata` decides whether an event has a line at all; this decides whether the room is
 * due to hear it. State is per-laptop rather than replicated: this is presentation, and the
 * authority is the only machine voicing every agent, so there is nothing for two laptops to
 * disagree about.
 */
export class SpeechNarrator {
  /** sessionId -> file names saved since that agent last said anything about its writes. */
  private readonly pending = new Map<string, string[]>();
  private readonly lastSpokenAt = new Map<string, number>();
  /** speaker -> the last presence sentence said for them, and when. */
  private readonly lastPresence = new Map<string, { text: string; at: number }>();

  constructor(
    private readonly cooldownMs = WRITE_COOLDOWN_MS,
    private readonly repeatWindowMs = REPEAT_WINDOW_MS,
  ) {}

  /** The line to speak for this event, or nothing if the room has heard enough. */
  line(event: Event, now: number): SpeechMetadata | undefined {
    const written = this.writeLine(event, now);
    if (written) return written;
    if (event.payload.type === 'FILE_WRITE') return undefined;

    const line = speechMetadata(event);
    if (!line || !isPresenceEvent(event)) return line;

    const said = this.lastPresence.get(line.speaker);
    if (said?.text === line.text && now - said.at < this.repeatWindowMs) return undefined;
    this.lastPresence.set(line.speaker, { text: line.text, at: now });
    return line;
  }

  /**
   * Record a write and, if the agent is due to speak, describe everything it has saved since it
   * last did. Returns nothing while an agent is mid-burst.
   */
  private writeLine(event: Event, now: number): SpeechMetadata | undefined {
    const payload = event.payload;
    const sessionId = event.actor.sessionId;
    // The worktree watcher reports the person's own edits too, with no session behind them.
    // Narrating those would have the room read your editor back to you.
    if (payload.type !== 'FILE_WRITE' || event.actor.kind !== 'agent' || !sessionId) {
      return undefined;
    }

    const safe = redactPayload(payload) as typeof payload;
    const files = this.pending.get(sessionId) ?? [];
    // A watcher flush and the agent's own hook can both report one save.
    const name = basename(safe.path);
    if (!files.includes(name)) files.push(name);
    this.pending.set(sessionId, files);

    const last = this.lastSpokenAt.get(sessionId);
    if (last !== undefined && now - last < this.cooldownMs) return undefined;
    this.lastSpokenAt.set(sessionId, now);
    this.pending.set(sessionId, []);
    // Routine: the queue evicts this first when a collision needs the speaker.
    return { speaker: sessionId, text: sentence(files, event.seq), priority: 0 };
  }
}

function sentence(files: string[], seq: number): string {
  const verb = VERBS[seq % VERBS.length];
  const named = files.slice(0, MAX_NAMED);
  const rest = files.length - named.length;
  // The "and" belongs to whatever ends the sentence: the last name, or the count.
  if (rest > 0) {
    return `${verb} ${named.join(', ')} and ${spell(rest)} other file${rest === 1 ? '' : 's'}.`;
  }
  const list = named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0];
  return `${verb} ${list}.`;
}

/** Parler reads a word more reliably than a numeral. */
function spell(count: number): string {
  return NUMBERS[count] ?? String(count);
}
