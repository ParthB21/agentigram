import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Payload } from '@agentigram/protocol';

export type RunAttribution = { commit: string; runId?: string; model?: string };
export type ContractCheck = {
  owner: string;
  repo: string;
  headSha: string;
  pullRequest: number;
  name: 'agentigram/contracts';
};
export type GitHubAdapters = {
  ingest?: (payloads: Payload[]) => Promise<void>;
  requestContractCheck?: (
    check: ContractCheck,
  ) => Promise<{ conclusion: 'success' | 'failure'; summary: string }>;
  publishCheckRun?: (
    check: ContractCheck & { conclusion: 'success' | 'failure'; summary: string },
  ) => Promise<void>;
};
export type GitHubResult = {
  events: Payload[];
  attributions: RunAttribution[];
  checkRequested: boolean;
};

/** Constant-time verification for GitHub's `X-Hub-Signature-256` header. */
export function verifyWebhookSignature(
  body: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature?.startsWith('sha256=') || secret.length === 0) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const supplied = signature.slice('sha256='.length);
  if (!/^[0-9a-f]{64}$/i.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
}

export function parseAttribution(message: string, commit = ''): RunAttribution {
  const trailers = new Map<string, string>();
  for (const line of message.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z-]+):\s*(.+)$/);
    if (match?.[1] && match[2]) trailers.set(match[1].toLowerCase(), match[2].trim());
  }
  return {
    commit,
    runId: trailers.get('agentigram-run') ?? trailers.get('agentigram-run'),
    model: trailers.get('agentigram-model') ?? trailers.get('agentigram-model'),
  };
}

export async function handleSignedWebhook(
  name: string,
  rawBody: string | Buffer,
  signature: string | undefined,
  secret: string,
  adapters: GitHubAdapters = {},
): Promise<GitHubResult> {
  if (!verifyWebhookSignature(rawBody, signature, secret))
    throw new Error('Invalid GitHub webhook signature');
  return handleWebhook(name, JSON.parse(rawBody.toString()), adapters);
}

/** Convert supported webhooks into authoritative facts. Source diffs are deliberately never fetched. */
export async function handleWebhook(
  name: string,
  payload: unknown,
  adapters: GitHubAdapters = {},
): Promise<GitHubResult> {
  const data = object(payload);
  const events: Payload[] = [];
  const attributions: RunAttribution[] = [];
  let checkRequested = false;
  if (name === 'push') {
    for (const commit of array(data.commits)) {
      const item = object(commit);
      attributions.push(parseAttribution(string(item.message), string(item.id)));
    }
  } else if (name === 'workflow_run' || name === 'check_run') {
    const run = object(data[name]);
    const commit = string(run.head_sha);
    const attribution = parseAttribution(string(object(run.head_commit).message), commit);
    attributions.push(attribution);
    const conclusion = string(run.conclusion);
    if (
      commit &&
      ['success', 'failure', 'cancelled', 'timed_out', 'action_required'].includes(conclusion)
    ) {
      events.push({
        type: 'CI_RESULT',
        commit,
        status: conclusion === 'success' ? 'pass' : 'fail',
        ...(attribution.runId ? { runId: attribution.runId } : {}),
      });
    }
  } else if (name === 'pull_request_review') {
    const review = object(data.review);
    const pr = object(data.pull_request);
    const state = string(review.state).toLowerCase();
    const mapped =
      state === 'approved'
        ? 'approved'
        : state === 'changes_requested'
          ? 'changes_requested'
          : 'commented';
    events.push({
      type: 'REVIEW_RESULT',
      pr: number(data.number),
      state: mapped,
      ...(string(object(pr.head).sha) ? { commit: string(object(pr.head).sha) } : {}),
    });
  } else if (name === 'pull_request') {
    const action = string(data.action);
    if (action === 'opened' || action === 'synchronize' || action === 'reopened') {
      const pr = object(data.pull_request);
      const baseRepo = object(object(pr.base).repo);
      const check: ContractCheck = {
        owner: string(object(baseRepo.owner).login),
        repo: string(baseRepo.name),
        headSha: string(object(pr.head).sha),
        pullRequest: number(data.number),
        name: 'agentigram/contracts',
      };
      if (
        check.owner &&
        check.repo &&
        check.headSha &&
        check.pullRequest > 0 &&
        adapters.requestContractCheck
      ) {
        checkRequested = true;
        const result = await adapters.requestContractCheck(check);
        await adapters.publishCheckRun?.({ ...check, ...result });
      }
    }
  }
  if (events.length > 0) await adapters.ingest?.(events);
  return { events, attributions, checkRequested };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
