import { z } from 'zod';

/** What a contract is (spec → "What a contract is"). Note: `symbol` has no `:kind` suffix here. */
export const ContractSchema = z.object({
  symbol: z.string().min(1),
  kind: z.enum(['type', 'data-shape', 'http-api']),
  before: z.string(),
  after: z.string(),
  constraint: z.string().optional(),
  migration: z.string().optional(),
});
export type Contract = z.infer<typeof ContractSchema>;
