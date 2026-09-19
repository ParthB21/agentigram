import { readLocalDaemonStatus } from '../../../../../lib/daemon-ipc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_INTERVAL_MS = 500;
const encoder = new TextEncoder();

function frame(event: string, value: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ teamId: string }> },
): Promise<Response> {
  const { teamId } = await context.params;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFingerprint = '';

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const poll = async () => {
        if (cancelled) return;
        try {
          const status = await readLocalDaemonStatus(teamId);
          if (cancelled) return;
          const fingerprint = `${status.transport}:${status.roomState.lastSeq}`;
          if (fingerprint !== lastFingerprint) {
            lastFingerprint = fingerprint;
            controller.enqueue(frame('snapshot', status));
          } else {
            controller.enqueue(frame('heartbeat', { at: Date.now() }));
          }
        } catch (error) {
          if (cancelled) return;
          controller.enqueue(
            frame('bridge-error', {
              message: error instanceof Error ? error.message : 'Local daemon unavailable',
            }),
          );
        }
        if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
      };
      void poll();
    },
    cancel() {
      cancelled = true;
      clearTimeout(timer);
    },
  });

  request.signal.addEventListener(
    'abort',
    () => {
      cancelled = true;
      clearTimeout(timer);
    },
    { once: true },
  );

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  });
}
