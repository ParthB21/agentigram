import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Persisted host conversation and the per-session lock, under `<base>/runner`. */
export class RunnerStore {
  private readonly dir: string;
  private readonly sessionFile: string;
  private readonly lockFile: string;

  constructor(
    base: string,
    key: string,
    private readonly host: string,
  ) {
    this.dir = join(base, 'runner');
    const safe = key.replace(/[^A-Za-z0-9_-]/g, '_');
    this.sessionFile = join(this.dir, `${safe}.json`);
    this.lockFile = join(this.dir, `${safe}.lock`);
  }

  read(): string | undefined {
    try {
      const saved = JSON.parse(readFileSync(this.sessionFile, 'utf8')) as {
        host?: string;
        hostSessionId?: string;
      };
      // A conversation from a different host cannot be resumed by this one.
      return saved.host === this.host ? saved.hostSessionId : undefined;
    } catch {
      return undefined;
    }
  }

  write(hostSessionId: string): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.sessionFile, JSON.stringify({ host: this.host, hostSessionId }));
  }

  clear(): void {
    rmSync(this.sessionFile, { force: true });
  }

  /**
   * One runner per session. The lock names a pid; a lock whose process is gone
   * (a crash) is taken over rather than blocking forever.
   */
  lock(pid = process.pid, alive: (pid: number) => boolean = processAlive): () => void {
    mkdirSync(this.dir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(this.lockFile, String(pid), { flag: 'wx' });
        return () => {
          try {
            if (readFileSync(this.lockFile, 'utf8') === String(pid)) rmSync(this.lockFile);
          } catch {
            // Already gone.
          }
        };
      } catch {
        const holder = Number(readFileSync(this.lockFile, 'utf8').trim());
        if (Number.isInteger(holder) && holder !== pid && alive(holder)) {
          throw new Error(`another runner (pid ${holder}) already manages this session`);
        }
        rmSync(this.lockFile, { force: true });
      }
    }
    throw new Error('could not take the runner lock');
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
