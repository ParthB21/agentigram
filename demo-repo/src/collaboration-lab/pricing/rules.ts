export interface DiscountContext {
  quantity: number;
  subtotalCents: number;
  member: boolean;
}

export type DiscountRule = (context: DiscountContext) => number;

export const bulkDiscount: DiscountRule = ({ quantity, subtotalCents }) =>
  quantity >= 5 ? Math.round(subtotalCents * 0.1) : 0;

export const memberDiscount: DiscountRule = ({ member, subtotalCents }) =>
  member ? Math.round(subtotalCents * 0.05) : 0;
