import { type Event, emptyRoomState, type NewEvent, type RoomState } from '@agentigram/protocol';
import { type Effect, reduce } from '@agentigram/reducer';

export type ScenarioStep = { atMs: number; event: NewEvent };

export type ScenarioSession = {
  sessionId: string;
  engineerId: string;
  role: string;
  model: string;
  host: string;
  branch: string;
};

export type ScenarioResult = { events: Event[]; state: RoomState; effects: Effect[] };

export type ScenarioAssertion = {
  name: string;
  check: (result: ScenarioResult) => boolean;
};

/** An ordered list of `{ atMs, event }` plus the assertions a correct run must satisfy. */
export type Scenario = {
  name: string;
  description: string;
  sessions: ScenarioSession[];
  steps: ScenarioStep[];
  assertions: ScenarioAssertion[];
};

/** Fixed clock so replays are byte-identical. */
export const SCENARIO_EPOCH_MS = Date.parse('2026-09-19T12:00:00.000Z');

/** Stamps a scenario the way the coordinator would (seq = position, ts = epoch + atMs). Pure. */
export function stamp(step: ScenarioStep, seq: number, roomId: string): Event {
  return {
    ...step.event,
    roomId,
    seq,
    ts: new Date(SCENARIO_EPOCH_MS + step.atMs).toISOString(),
  };
}

/** Runs the scenario through the real reducer, headless. */
export function runScenario(scenario: Scenario, roomId = 'sim'): ScenarioResult {
  let state = emptyRoomState(roomId);
  const events: Event[] = [];
  const effects: Effect[] = [];
  scenario.steps.forEach((step, i) => {
    const event = stamp(step, i + 1, roomId);
    const out = reduce(state, event);
    state = out.state;
    events.push(event);
    effects.push(...out.effects);
  });
  return { events, state, effects };
}

/** Returns the names of failed assertions (empty means the run matched expectations). */
export function checkScenario(scenario: Scenario, result: ScenarioResult): string[] {
  return scenario.assertions.filter((a) => !a.check(result)).map((a) => a.name);
}
