import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** How much of a transcript's tail to search. The newest assistant turn is at the end. */
const TAIL_BYTES = 256 * 1024;
const MODEL_FIELD = /"model"\s*:\s*"([^"]+)"/g;
/** Names hosts write that are not a model at all. */
const NOT_A_MODEL = new Set(['<synthetic>', 'unknown', '']);

type HookLike = { model?: string | undefined; transcript_path?: string | null | undefined };

/** The last real `"model": "..."` in a host transcript, or undefined. Only that string is read out. */
export function modelFromTranscript(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const found = [...buffer.toString('utf8').matchAll(MODEL_FIELD)]
      .map((match) => match[1] ?? '')
      .filter((name) => !NOT_A_MODEL.has(name));
    return found.at(-1);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function codexConfiguredModel(home: string): string | undefined {
  const file = join(home, '.codex', 'config.toml');
  if (!existsSync(file)) return undefined;
  try {
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(readFileSync(file, 'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The model this host's agent is actually running, read from the laptop it runs on.
 *
 * Hook payloads are meant to carry `model`, but Claude Code and Codex do not reliably send it,
 * and nothing else in the room knows it — so every session, and every model comparison built on
 * it, came out as "unknown". In order: the payload, the host's own transcript (it records the
 * model on each assistant turn), then the host's configured default.
 */
export function resolveHostModel(
  host: string,
  input: HookLike,
  home = homedir(),
): string | undefined {
  const usable = (name: string | undefined) => (name && !NOT_A_MODEL.has(name) ? name : undefined);
  const direct = usable(input.model);
  if (direct) return direct;
  const fromTranscript = input.transcript_path
    ? usable(modelFromTranscript(input.transcript_path))
    : undefined;
  if (fromTranscript) return fromTranscript;
  if (host === 'codex') return usable(codexConfiguredModel(home));
  if (host === 'claude-code') return usable(process.env.ANTHROPIC_MODEL);
  return undefined;
}
