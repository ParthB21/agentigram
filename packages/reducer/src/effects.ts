import type { Contract, Event } from '@agentigram/protocol';

/** Side effects the coordinator performs after a reduction. The reducer itself does no I/O. */
export type Broadcast = {
  kind: 'broadcast';
  /** Session ids (agents' daemons) or every connected dashboard. */
  to: string[] | 'dashboards';
  event: Event;
};
export type ScheduleAlarm = {
  kind: 'schedule_alarm';
  at: string;
  reason: string;
  leaseId?: string;
};
export type RequestSpecMerge = { kind: 'request_spec_merge'; sessions: string[]; reason: string };
export type RequestContractCompile = {
  kind: 'request_contract_compile';
  collisionId: string;
  contract: Contract;
};
export type PersistBatch = { kind: 'persist_batch'; events: Event[] };

export type Effect =
  | Broadcast
  | ScheduleAlarm
  | RequestSpecMerge
  | RequestContractCompile
  | PersistBatch;
