'use client';

import { useEffect, useMemo, useState } from 'react';
import { demoEvents, describeEvent } from '../lib/demo-data';
import { replayRoom } from '../lib/room-stream';
import { useRoomStream } from '../lib/use-room-stream';

const REPLAY_INTERVAL_MS = 250;

export function TimelineView({ teamId }: { teamId: string }) {
  const stream = useRoomStream(teamId);
  const events = stream.events.length > 0 ? stream.events : demoEvents;
  const lastSequence = events.at(-1)?.seq ?? 0;
  const [cursor, setCursor] = useState(lastSequence);
  const [playing, setPlaying] = useState(false);

  useEffect(() => setCursor(lastSequence), [lastSequence]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setCursor((current) => {
        if (current >= lastSequence) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, REPLAY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [lastSequence, playing]);

  const replayed = useMemo(() => replayRoom(teamId, events, cursor), [cursor, events, teamId]);
  const collisionCount = useMemo(
    () =>
      new Set(
        events
          .filter((event) => event.seq <= cursor && event.payload.type === 'COLLISION')
          .map((event) => (event.payload.type === 'COLLISION' ? event.payload.collisionId : '')),
      ).size,
    [cursor, events],
  );
  const visible = events
    .filter((event) => event.seq <= cursor)
    .slice(-12)
    .reverse();

  return (
    <div className="page timeline-page">
      <header className="page-header">
        <div>
          <p className="context-line">Ordered event log</p>
          <h1>Replay the room.</h1>
          <p>Every view is rebuilt from the same event sequence as the coordinator.</p>
        </div>
        <span className="seed-label">
          {stream.events.length === 0 ? 'Seeded rehearsal' : 'Live history'}
        </span>
      </header>

      <section className="replay-console">
        <div className="replay-topline">
          <button
            type="button"
            className="play-button"
            onClick={() => {
              if (cursor >= lastSequence) setCursor(0);
              setPlaying((value) => !value);
            }}
          >
            {playing ? 'Pause replay' : 'Play at 4×'}
          </button>
          <strong>
            Sequence {cursor} / {lastSequence}
          </strong>
          <span>
            {replayed.teamSummary.activeSessions} active · {collisionCount} collisions
          </span>
        </div>
        <input
          aria-label="Timeline sequence"
          max={lastSequence}
          min="0"
          onChange={(event) => {
            setPlaying(false);
            setCursor(Number(event.target.value));
          }}
          type="range"
          value={cursor}
        />
        <div className="milestones" aria-hidden="true">
          <span>Join</span>
          <span>Predict</span>
          <span>Detect</span>
          <span>Agree</span>
          <span>Verify</span>
        </div>
      </section>

      <section className="timeline-list" aria-label="Events through selected sequence">
        {visible.map((item) => (
          <article key={item.seq} className="timeline-event">
            <span className="sequence">#{item.seq}</span>
            <span className={`event-mark event-${item.payload.type.toLowerCase()}`}></span>
            <div>
              <strong>{describeEvent(item)}</strong>
              <p>
                {item.actor.sessionId ?? item.actor.engineerId} · {item.payload.type}
              </p>
            </div>
            <time>
              {new Date(item.ts).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </time>
          </article>
        ))}
      </section>
    </div>
  );
}
