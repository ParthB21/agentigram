import type { PosteriorCell, SessionReport } from './types.js';

const pct = (value: number): string => `${Math.round(value * 100)}%`;
const rate = (cell: PosteriorCell | null): string =>
  cell ? `${pct(cell.median)} (${pct(cell.lower)}–${pct(cell.upper)})` : 'n/a';
const dur = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined) return '–';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const cellText = (value: string): string => value.replace(/\|/g, '\\|');
const table = (head: string[], rows: string[][]): string[] => [
  `| ${head.join(' | ')} |`,
  `| ${head.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.map(cellText).join(' | ')} |`),
  '',
];

/** The human-readable end-of-session log. The JSON beside it is the source; this is a view of it. */
export function renderMarkdown(report: SessionReport): string {
  const out: string[] = [];
  const label = new Map(report.agents.map((a) => [a.sessionId, `${a.sessionId} (${a.model})`]));
  const who = (id?: string): string => (id ? (label.get(id) ?? id) : 'room');

  out.push(`# Session report — ${report.roomId}`, '');
  out.push(
    `Generated ${report.generatedAt} · ${report.eventCount} events (seq ${report.window.firstSeq}–${report.window.lastSeq}) · ${dur(report.window.durationMs)} · method v${report.methodVersion}`,
    `Event log SHA-256: \`${report.eventsSha256}\``,
    '',
  );

  out.push('## Model comparison', '');
  out.push(
    ...table(
      [
        'Model',
        'Sessions',
        'Pass / fail / unverified',
        'Success rate (80%)',
        'Conflicts caused',
        'Verified',
        'Escalated',
        'Lease denials',
        'Cost',
      ],
      report.models.map((m) => [
        m.model,
        String(m.sessions),
        `${m.passes} / ${m.fails} / ${m.unverified}`,
        rate(m.successRate),
        String(m.conflictsCaused),
        String(m.conflictsVerified),
        String(m.conflictsEscalated),
        String(m.leaseDenials),
        m.costUsd > 0 ? `$${m.costUsd.toFixed(2)}` : '–',
      ]),
    ),
  );

  out.push('## By category', '');
  const cats = report.models.flatMap((m) =>
    m.byCategory.map((c) => [
      c.category,
      m.model,
      `${c.passes}/${c.scored}`,
      rate(c.successRate),
      dur(c.medianDurationMs),
      c.unverified > 0 ? String(c.unverified) : '–',
    ]),
  );
  out.push(
    ...table(
      ['Category', 'Model', 'Passed', 'Success rate (80%)', 'Median time to pass', 'Unverified'],
      cats.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ),
  );

  if (report.headToHead.length > 0) {
    out.push('## Head to head', '');
    out.push(
      ...table(
        ['Category', 'A', 'B', 'n(A) / n(B)', 'P(A > B)', 'Verdict'],
        report.headToHead.map((h) => [
          h.category,
          h.a,
          h.b,
          `${h.nA} / ${h.nB}`,
          h.probabilityAOverB === null ? 'n/a' : pct(h.probabilityAOverB),
          h.winner ?? `not enough data (needs n ≥ 5 each and P ≥ 90%)`,
        ]),
      ),
    );
  }
  if (report.duels > 0) {
    out.push(`## Paired duels (${report.duels})`, '');
    out.push(
      ...table(
        ['Model', 'Bradley–Terry strength'],
        Object.entries(report.duelRatings)
          .sort((a, b) => b[1] - a[1])
          .map(([model, s]) => [model, s.toFixed(2)]),
      ),
    );
  }

  out.push('## Who did what', '');
  out.push(
    ...table(
      [
        'Agent',
        'Category',
        'Task',
        'Files written',
        'Collisions caused / hit',
        'Blocked',
        'Negotiation (prop / counter / accept / esc)',
        'Outcome',
      ],
      report.agents.map((a) => [
        who(a.sessionId),
        a.category,
        a.task ?? '–',
        String(a.filesWritten.length),
        `${a.collisionsCaused} / ${a.collisionsAffected}`,
        dur(a.leaseBlockedMs),
        `${a.proposals} / ${a.counters} / ${a.accepts} / ${a.escalations}`,
        a.outcome,
      ]),
    ),
  );

  out.push(`## Conflicts (${report.conflicts.length})`, '');
  if (report.conflicts.length === 0) out.push('None detected.', '');
  for (const c of report.conflicts) {
    out.push(
      `### ${c.tier} · ${c.symbols.slice(0, 2).join(', ')}${c.symbols.length > 2 ? ' …' : ''}`,
      `Opened at seq ${c.openedSeq} (${c.openedAt}) by ${who(c.writer)}, affecting ${c.affected.map(who).join(', ') || 'no one yet'}.`,
      `**Resolution: ${c.resolution}**${c.timeToResolutionMs !== undefined ? ` in ${dur(c.timeToResolutionMs)}` : ''}${c.contractResult ? ` · contract ${c.contractResult}` : ''}`,
      '',
    );
    for (const a of c.actions) {
      out.push(`- #${a.seq} ${who(a.by)} ${a.kind}${a.note ? `: ${a.note}` : ''}`);
    }
    out.push('');
  }

  out.push('## Timeline', '');
  for (const t of report.timeline) {
    out.push(`- \`#${t.seq}\` ${t.ts.slice(11, 19)} **${who(t.session)}** ${t.kind}: ${t.text}`);
  }
  out.push('');

  out.push('## Caveats', '');
  for (const caveat of report.caveats) out.push(`- ${caveat}`);
  out.push('');
  return out.join('\n');
}
