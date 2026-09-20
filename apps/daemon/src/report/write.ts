import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { renderMarkdown } from './render.js';
import type { SessionReport } from './types.js';

/**
 * Reports live outside the room's p2p storage on purpose: `agg leave` deletes
 * that storage, and the record of what happened must outlive the room.
 */
export const defaultReportDir = (): string => join(homedir(), '.agentigram', 'reports');

/** Newest markdown report for a room, so `agg leave` can point at what the shutdown just wrote. */
export function latestReport(roomId: string, dir = defaultReportDir()): string | undefined {
  const prefix = `${roomId.replace(/[^A-Za-z0-9_-]/g, '_')}-`;
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.md'))
      .sort()
      .at(-1)
      ?.replace(/^/, `${dir}${sep}`);
  } catch {
    return undefined;
  }
}

export function writeReport(
  report: SessionReport,
  dir = defaultReportDir(),
): { json: string; markdown: string } {
  mkdirSync(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const room = report.roomId.replace(/[^A-Za-z0-9_-]/g, '_');
  const base = join(dir, `${room}-${stamp}`);
  const json = `${base}.json`;
  const markdown = `${base}.md`;
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdown, renderMarkdown(report));
  return { json, markdown };
}
