import type { Scenario } from '../scenario.js';
import { userIdUuid } from './user-id-uuid.js';

export const SCENARIOS: Record<string, Scenario> = { [userIdUuid.name]: userIdUuid };
export { userIdUuid };
