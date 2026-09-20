import { createHash } from 'node:crypto';
import type { Event } from '@agentigram/protocol';
import { deriveFacts } from './build.js';
import { duelRatings, headToHead, scoreModels } from './score.js';
import { REPORT_METHOD_VERSION, type SessionReport } from './types.js';

export { renderMarkdown } from './render.js';
export type * from './types.js';
export { latestReport, writeReport } from './write.js';

/**
 * Turn the room's authoritative event log into a scored session report.
 *
 * Nothing here is asked of a model or supplied by a question bank: every number
 * is a count over what agents did and what the room verified, so the same log
 * always yields the same report and anyone holding the log can re-derive it.
 */
export function buildReport(events: Event[], generatedAt: string): SessionReport {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const { agents, conflicts, timeline, duels } = deriveFacts(ordered);
  const models = scoreModels(agents, conflicts);
  const first = ordered[0];
  const last = ordered.at(-1);
  const start = first ? Date.parse(first.ts) : Number.NaN;
  const end = last ? Date.parse(last.ts) : Number.NaN;

  const caveats: string[] = [];
  if (agents.some((a) => a.model === 'unknown'))
    caveats.push('Some sessions never reported a model and are grouped as "unknown".');
  if (models.length < 2)
    caveats.push('Only one model took part, so there is no model comparison in this session.');
  if (duels.length === 0 && models.length >= 2)
    caveats.push(
      'No paired duels ran. Models worked on different tasks, so task difficulty is not controlled; treat head-to-head as indicative only.',
    );
  const unverified = agents.filter((a) => a.outcome === 'unverified').length;
  if (unverified > 0)
    caveats.push(
      `${unverified} session(s) had no CI, contract or run verification, so they are left out of success rates rather than counted as failures.`,
    );
  caveats.push(
    'Task categories come from keyword rules on the stated task (or the files touched), not from human confirmation.',
  );

  return {
    methodVersion: REPORT_METHOD_VERSION,
    roomId: first?.roomId ?? 'unknown',
    generatedAt,
    window: {
      firstSeq: first?.seq ?? 0,
      lastSeq: last?.seq ?? 0,
      ...(first ? { firstTs: first.ts } : {}),
      ...(last ? { lastTs: last.ts } : {}),
      ...(Number.isFinite(start) && Number.isFinite(end)
        ? { durationMs: Math.max(0, end - start) }
        : {}),
    },
    eventsSha256: createHash('sha256')
      .update(ordered.map((e) => JSON.stringify(e)).join('\n'))
      .digest('hex'),
    eventCount: ordered.length,
    agents,
    conflicts,
    models,
    headToHead: headToHead(agents),
    duelRatings: duelRatings(agents, duels),
    duels: duels.length,
    timeline,
    caveats,
  };
}
