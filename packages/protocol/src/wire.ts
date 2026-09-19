import { z } from 'zod';
import { EventSchema, NewEventSchema } from './event.js';
import { RoomStateSchema } from './state.js';

export const CLIENT_KINDS = ['daemon', 'dashboard', 'worker'] as const;
export const ClientKindSchema = z.enum(CLIENT_KINDS);
export type ClientKind = z.infer<typeof ClientKindSchema>;

// client → server
export const HelloSchema = z.object({
  type: z.literal('HELLO'),
  roomId: z.string(),
  lastSeq: z.number().int().nonnegative(),
  client: ClientKindSchema,
  sessionId: z.string().optional(),
  token: z.string(),
});
export const SubmitSchema = z.object({ type: z.literal('SUBMIT'), event: NewEventSchema });
export const HeartbeatMsgSchema = z.object({
  type: z.literal('HEARTBEAT'),
  sessionId: z.string().optional(),
});
export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloSchema,
  SubmitSchema,
  HeartbeatMsgSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// server → client
export const WelcomeSchema = z.object({
  type: z.literal('WELCOME'),
  roomState: RoomStateSchema,
  fromSeq: z.number().int().nonnegative(),
});
export const EventsMsgSchema = z.object({
  type: z.literal('EVENTS'),
  events: z.array(EventSchema),
});
export const AckSchema = z.object({
  type: z.literal('ACK'),
  id: z.string(),
  seq: z.number().int(),
});
export const ERROR_CODES = [
  'BAD_MESSAGE',
  'UNAUTHORIZED',
  'NOT_HELLO',
  'ROOM_MISMATCH',
  'INTERNAL',
] as const;
export const ErrorMsgSchema = z.object({
  type: z.literal('ERROR'),
  code: z.enum(ERROR_CODES),
  message: z.string(),
  id: z.string().optional(),
});
export const ServerMessageSchema = z.discriminatedUnion('type', [
  WelcomeSchema,
  EventsMsgSchema,
  AckSchema,
  ErrorMsgSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ErrorCode = (typeof ERROR_CODES)[number];
