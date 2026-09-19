import { type Env, RoomDO } from './room-do.js';

export { RoomDO };

const ROOM_PATH = /^\/room\/([A-Za-z0-9_-]{1,64})(\/ingest)?$/;

/** Routes `/room/:roomId[/ingest]` to that room's Durable Object; everything else is 404. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') return new Response('ok');
    const match = ROOM_PATH.exec(pathname);
    if (!match?.[1]) return new Response('not found', { status: 404 });
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  },
} satisfies ExportedHandler<Env>;
