import type { Scenario } from '../scenario.js';
import { orchestratorPlan } from './orchestrator-plan.js';
import { userIdUuid } from './user-id-uuid.js';

export const SCENARIOS: Record<string, Scenario> = {
  [userIdUuid.name]: userIdUuid,
  [orchestratorPlan.name]: orchestratorPlan,
};
export { orchestratorPlan, userIdUuid };
