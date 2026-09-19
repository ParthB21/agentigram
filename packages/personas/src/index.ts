import { type Event, NotImplementedError } from '@clankergram/protocol';

export type PersonaCard = {
  role: string;
  tone: string;
  verbosity: 'terse' | 'normal' | 'chatty';
  catchphrases: string[];
};
export type PersonaLine = { speaker: string; text: string; seq: number };

/**
 * Renders dialogue from a window of structured events. Dashboard-only: output never flows back
 * into agent context or project state. Every line carries the `seq` of the event it depicts.
 */
export function render(
  _eventsWindow: Event[],
  _personaCards: PersonaCard[],
): Promise<PersonaLine[]> {
  throw new NotImplementedError('personas.render (Part 4)');
}
