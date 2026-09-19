import { z } from 'zod';
import { PayloadSchema } from './payloads.js';

export const ActorSchema = z.object({
  engineerId: z.string(),
  sessionId: z.string().optional(),
  kind: z.enum(['agent', 'human', 'system']),
});
export type Actor = z.infer<typeof ActorSchema>;

export const SOURCES = ['hook', 'watcher', 'mcp', 'github', 'otel', 'system'] as const;
export const SourceSchema = z.enum(SOURCES);

/** The full event as stored and broadcast. `seq` and `ts` are assigned only by the coordinator. */
export const EventSchema = z.object({
  id: z.string(), // client-generated (crypto.randomUUID()), for dedupe
  seq: z.number().int().nonnegative(),
  roomId: z.string(),
  ts: z.string(),
  actor: ActorSchema,
  causedBy: z.number().int().nonnegative().optional(),
  source: SourceSchema,
  payload: PayloadSchema,
});
export type Event = z.infer<typeof EventSchema>;

/** What a client submits: an event without `seq` and `ts`. */
export const NewEventSchema = EventSchema.omit({ seq: true, ts: true });
export type NewEvent = z.infer<typeof NewEventSchema>;
