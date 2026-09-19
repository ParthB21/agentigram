'use client';

import type { PayloadType } from '@clankergram/protocol';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { activeCollision, agents, demoEvents, describeEvent } from '../lib/demo-data';
import { useRoomStream } from '../lib/use-room-stream';

const filters: Array<{ label: string; types?: PayloadType[] }> = [
  { label: 'All' },
  { label: 'Changes', types: ['FILE_WRITE', 'API_DELTA', 'INTENT'] },
  { label: 'Coordination', types: ['COLLISION', 'MESSAGE', 'PROPOSAL', 'ACCEPT'] },
  { label: 'Checks', types: ['SPEC_MERGE_RESULT', 'CONTRACT_RESULT', 'RUN_VERIFIED'] },
];

export function RoomView({ teamId }: { teamId: string }) {
  const stream = useRoomStream(teamId);
  const events = stream.events.length > 0 ? stream.events : demoEvents;
  const seeded = stream.events.length === 0;
  const displayedAgents = seeded
    ? agents
    : Object.values(stream.roomState.sessions)
        .filter((session) => session.status !== 'ended')
        .map((session) => ({
          id: session.sessionId,
          engineer: session.engineerId,
          role: session.role ?? session.sessionId,
          model: session.model,
          host: session.host,
          branch: session.branch,
          task: session.task ?? session.intent?.task ?? 'Awaiting task intent',
          status: session.status,
          lease: Object.values(stream.roomState.leases)
            .find((lease) => lease.sessionId === session.sessionId)
            ?.symbols[0]?.split('#')
            .at(-1)
            ?.split(':')[0],
        }));
  const [filter, setFilter] = useState('All');
  const shownEvents = useMemo(() => {
    const selected = filters.find((item) => item.label === filter);
    const matching = selected?.types
      ? events.filter((event) => selected.types?.includes(event.payload.type))
      : events;
    return matching.slice(-8).reverse();
  }, [events, filter]);

  return (
    <div className="page room-page">
      <header className="page-header room-heading">
        <div>
          <p className="context-line">Room / {teamId}</p>
          <h1>Four agents, one codebase.</h1>
          <p>Agentigram is watching the seams between their work.</p>
        </div>
        <div className="connection-state">
          <i className={stream.status === 'live' ? 'live' : ''}></i>
          <span>{seeded ? 'Rehearsal data' : stream.status}</span>
          {seeded && <b>Seeded</b>}
        </div>
      </header>

      <section className="signal-board" aria-labelledby="collision-title">
        <div className="signal-copy">
          <div className="signal-kicker">
            <span>Semantic collision</span>
            <strong>{Math.round(activeCollision.confidence * 100)}% confidence</strong>
          </div>
          <h2 id="collision-title">Backend changed an interface Payments already depends on.</h2>
          <p>{activeCollision.detail}</p>
          <code>{activeCollision.symbol}</code>
        </div>
        <div
          className="signal-path"
          role="img"
          aria-label="Collision flow from Backend to Payments"
        >
          <span className="role-avatar backend">B</span>
          <div>
            <i></i>
            <b>contract proposed</b>
            <i></i>
          </div>
          <span className="role-avatar payments">P</span>
        </div>
        <Link className="text-action" href={`/team/${teamId}/collisions`}>
          Review collision
        </Link>
      </section>

      <div className="room-grid">
        <section className="agents-panel" aria-labelledby="agents-title">
          <div className="section-heading">
            <h2 id="agents-title">Agents</h2>
            <span>{displayedAgents.filter((agent) => agent.status !== 'idle').length} working</span>
          </div>
          <div className="agent-list">
            {displayedAgents.map((agent) => (
              <article className="agent-row" key={agent.id}>
                <span className={`role-avatar ${agent.id}`}>{agent.role[0]}</span>
                <div className="agent-primary">
                  <strong>{agent.role}</strong>
                  <span>{agent.task}</span>
                </div>
                <div className="agent-model">
                  <strong>{agent.model}</strong>
                  <span>{agent.branch}</span>
                </div>
                <span className={`agent-state ${agent.status}`}>{agent.status}</span>
                {agent.lease && <code className="lease">{agent.lease}</code>}
              </article>
            ))}
          </div>
        </section>

        <section className="feed-panel" aria-labelledby="feed-title">
          <div className="section-heading feed-heading">
            <div>
              <h2 id="feed-title">Live activity</h2>
              <span>seq {events.at(-1)?.seq ?? 0}</span>
            </div>
            <fieldset className="filter-row">
              <legend>Filter events</legend>
              {filters.map((item) => (
                <button
                  className={filter === item.label ? 'selected' : ''}
                  key={item.label}
                  onClick={() => setFilter(item.label)}
                  type="button"
                >
                  {item.label}
                </button>
              ))}
            </fieldset>
          </div>
          <ol className="event-list">
            {shownEvents.map((event) => (
              <li key={event.seq}>
                <time>
                  {new Date(event.ts).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </time>
                <span className={`event-dot event-${event.payload.type.toLowerCase()}`}></span>
                <p>
                  <strong>#{event.seq}</strong>
                  {describeEvent(event)}
                </p>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
