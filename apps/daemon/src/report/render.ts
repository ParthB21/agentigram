import type { PosteriorCell, SessionReport } from './types.js';

const TIMELINE_CAP = 30;
const pct = (value: number): string => `${Math.round(value * 100)}%`;
const rate = (cell: PosteriorCell | null): string =>
  cell ? `${pct(cell.median)} (${pct(cell.lower)}–${pct(cell.upper)})` : 'n/a';
const dur = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined) return '–';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const table = (head: string[], rows: string[][]): string[] => [
  `| ${head.join(' | ')} |`,
  `| ${head.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`),
  '',
];

/** The short human view of a report. The JSON beside it has everything; this is what fits on a screen. */
export function renderMarkdown(report: SessionReport): string {
  const out: string[] = [];
  const name = new Map(report.agents.map((a) => [a.sessionId, `${a.sessionId} (${a.model})`]));
  const who = (id?: string): string => (id ? (name.get(id) ?? id) : 'room');

  out.push(
    `# Session report — ${report.roomId}`,
    `${dur(report.window.durationMs)} · ${report.eventCount} events · log \`${report.eventsSha256.slice(0, 12)}\` (full hash in the JSON)`,
    '',
    '## Models',
    '',
    ...table(
      [
        'Model',
        'Sessions',
        'Pass / fail / unverified',
        'Success (80%)',
        'Conflicts caused / verified / escalated',
      ],
      report.models.map((m) => [
        m.model,
        String(m.sessions),
        `${m.passes} / ${m.fails} / ${m.unverified}`,
        rate(m.successRate),
        `${m.conflictsCaused} / ${m.conflictsVerified} / ${m.conflictsEscalated}`,
      ]),
    ),
  );

  const categories = report.models.flatMap((m) =>
    m.byCategory
      .filter((c) => c.scored > 0)
      .map((c) => [
        c.category,
        m.model,
        `${c.passes}/${c.scored}`,
        rate(c.successRate),
        dur(c.medianDurationMs),
      ]),
  );
  if (categories.length > 0) {
    out.push(
      '## By category',
      '',
      ...table(['Category', 'Model', 'Passed', 'Success (80%)', 'Median time'], categories),
    );
  }

  // The overall row always; a category row only when it produced a verdict.
  const versus = report.headToHead.filter((h) => h.category === 'ALL' || h.winner);
  if (versus.length > 0) {
    out.push(
      '## Head to head',
      '',
      ...table(
        ['Category', 'A vs B', 'n', 'P(A > B)', 'Verdict'],
        versus.map((h) => [
          h.category,
          `${h.a} vs ${h.b}`,
          `${h.nA} / ${h.nB}`,
          h.probabilityAOverB === null ? 'n/a' : pct(h.probabilityAOverB),
          h.winner ?? 'not enough data (needs n ≥ 5 each, P ≥ 90%)',
        ]),
      ),
    );
  }
  if (report.duels > 0) {
    const ratings = Object.entries(report.duelRatings).sort((a, b) => b[1] - a[1]);
    out.push(
      `## Duels (${report.duels})`,
      '',
      ...ratings.map(([model, s]) => `- ${model}: ${s.toFixed(2)}`),
      '',
    );
  }

  out.push(
    '## Agents',
    '',
    ...table(
      ['Agent', 'Task', 'Category', 'Writes', 'Outcome'],
      report.agents.map((a) => [
        who(a.sessionId),
        a.task ?? '–',
        a.category,
        String(a.filesWritten.length),
        a.outcome,
      ]),
    ),
    '## Conflicts',
    '',
  );
  if (report.conflicts.length === 0) out.push('None.', '');
  for (const c of report.conflicts) {
    const steps = [
      ...c.actions.filter((a) => a.kind !== 'MESSAGE').map((a) => a.kind),
      ...(c.contractResult ? [`contract ${c.contractResult}`] : []),
    ];
    out.push(
      `- **${c.tier}** ${c.symbols[0] ?? 'file'} — ${who(c.writer)} vs ${c.affected.map(who).join(', ') || '?'} · ${c.resolution}${c.timeToResolutionMs !== undefined ? ` in ${dur(c.timeToResolutionMs)}` : ''}${steps.length > 0 ? ` (${steps.join(' → ')})` : ''}`,
    );
  }
  out.push('');

  if (report.timeline.length > 0) {
    const shown = report.timeline.slice(0, TIMELINE_CAP);
    out.push('## Timeline', '');
    for (const t of shown) out.push(`- ${t.ts.slice(11, 19)} ${who(t.session)} — ${t.text}`);
    if (report.timeline.length > shown.length) {
      out.push(`- … ${report.timeline.length - shown.length} more in the JSON`);
    }
    out.push('');
  }

  if (report.caveats.length > 0)
    out.push('## Notes', '', ...report.caveats.map((c) => `- ${c}`), '');
  return out.join('\n');
}
