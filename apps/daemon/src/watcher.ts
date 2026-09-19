import { execFileSync } from 'node:child_process';
import { relative, sep } from 'node:path';
import { apiDelta } from '@agentigram/analysis';
import type { NewEvent } from '@agentigram/protocol';
import { type AsyncSubscription, subscribe } from '@parcel/watcher';

const WATCH_DEBOUNCE_MS = 150;

export type WatcherOptions = {
  roomId: string;
  engineerId: string;
  sessionId: string;
  root: string;
  submit(event: NewEvent): void;
  onChange?(relativePaths: string[]): void;
  isRecentAgentWrite(path: string): boolean;
  log(message: string, error?: unknown): void;
};

function mergeBase(root: string): string {
  for (const branch of ['main', 'master']) {
    try {
      return execFileSync('git', ['merge-base', 'HEAD', branch], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
    } catch {
      // Try the next conventional primary branch.
    }
  }
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

export class WorktreeWatcher {
  private subscription: AsyncSubscription | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly changed = new Set<string>();

  constructor(private readonly options: WatcherOptions) {}

  async start(): Promise<void> {
    if (this.subscription) return;
    this.subscription = await subscribe(
      this.options.root,
      (_error, events) => {
        for (const event of events) {
          if (event.type !== 'delete' && !event.path.includes('/.git/'))
            this.changed.add(event.path);
        }
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.flush(), WATCH_DEBOUNCE_MS);
      },
      { ignore: ['.git', 'node_modules', 'dist', '.next'] },
    );
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    await this.subscription?.unsubscribe();
    this.subscription = undefined;
  }

  private async flush(): Promise<void> {
    const paths = [...this.changed];
    this.changed.clear();
    const relativePaths = paths.map((p) => relative(this.options.root, p).split(sep).join('/'));
    this.options.onChange?.(relativePaths);
    for (const relativePath of relativePaths) {
      const agentWrite = this.options.isRecentAgentWrite(relativePath);
      this.options.submit({
        id: crypto.randomUUID(),
        roomId: this.options.roomId,
        actor: {
          engineerId: this.options.engineerId,
          ...(agentWrite ? { sessionId: this.options.sessionId } : {}),
          kind: agentWrite ? 'agent' : 'human',
        },
        source: 'watcher',
        payload: {
          type: 'FILE_WRITE',
          path: relativePath,
          worktree: this.options.root,
        },
      });
    }
    try {
      const changes = await apiDelta(mergeBase(this.options.root), this.options.root);
      const byModule = new Map<string, typeof changes>();
      for (const change of changes) {
        const module = change.symbol.split('#')[0] ?? 'unknown';
        byModule.set(module, [...(byModule.get(module) ?? []), change]);
      }
      for (const [module, moduleChanges] of byModule) {
        this.options.submit({
          id: crypto.randomUUID(),
          roomId: this.options.roomId,
          actor: {
            engineerId: this.options.engineerId,
            sessionId: this.options.sessionId,
            kind: 'agent',
          },
          source: 'watcher',
          payload: { type: 'API_DELTA', module, changes: moduleChanges },
        });
      }
    } catch (error) {
      this.options.log('API delta unavailable; Part 3 analysis is not implemented yet', error);
    }
  }
}
