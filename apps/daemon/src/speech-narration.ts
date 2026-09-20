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
export const WRITE_COOLDOWN_MS = 30_000;

/**
 * How long an arrival or a departure stays said.
 *
 * A session announces itself on every reconnect and ends twice whenever its own farewell is
 * followed by the authority noticing the socket close, so the same sentence can arrive two or
 * three times within a second. Saying it once is the whole rule: a genuine rejoin minutes later
 * is news again, and is spoken again.
 */
/** 5 minutes: stops agents re-saying the same line on every replan cycle. */
export const REPEAT_WINDOW_MS = 5 * 60_000;

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
  /** Presence hooks can be emitted by both a reconnect and the authority; each fact is said once. */
  private readonly spokenPresence = new Set<string>();
  /** speaker -> the last line said for them, and when. */
  private readonly lastSpoken = new Map<string, { text: string; at: number }>();
  /** Exact repeated lines can move between speakers when the orchestrator republishes them. */
  private readonly lastText = new Map<string, number>();
  /** The room allocation is an intro, not live conflict narration. */
  private announcedPlan = false;

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
    if (!line) return undefined;

    if (isPresenceEvent(event)) {
      const key = presenceKey(event);
      if (this.spokenPresence.has(key)) return undefined;
      this.spokenPresence.add(key);
      return line;
    }

    if (isPlanIntroduction(line.text)) {
      if (this.announcedPlan) return undefined;
      this.announcedPlan = true;
    }

    const normalized = normalizeLine(line.text);
    const previousTextAt = this.lastText.get(normalized);
    if (previousTextAt !== undefined && now - previousTextAt < this.repeatWindowMs) {
      return undefined;
    }

    const previous = this.lastSpoken.get(line.speaker);
    if (previous?.text === line.text && now - previous.at < this.repeatWindowMs) return undefined;
    this.lastSpoken.set(line.speaker, { text: line.text, at: now });
    this.lastText.set(normalized, now);
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

function presenceKey(event: Event): string {
  const payload = event.payload;
  return payload.type === 'SESSION_STARTED' || payload.type === 'SESSION_ENDED'
    ? `${payload.type}:${payload.sessionId}`
    : event.id;
}

function normalizeLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isPlanIntroduction(text: string): boolean {
  return (
    /^orchestrator:\s/i.test(text) ||
    /^agentigram's orchestrator has allocated\b/i.test(text)
  );
}
