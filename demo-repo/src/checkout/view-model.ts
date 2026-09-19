import type { CheckoutResponse } from './types';

/** What the checkout screen renders. Frontend owns this file. */
export interface CheckoutViewModel {
  orderId: string;
  customerId: number;
  totalLabel: string;
  paid: boolean;
}

export function toViewModel(response: CheckoutResponse): CheckoutViewModel {
  return {
    orderId: response.orderId,
    customerId: response.userId,
    totalLabel: `$${(response.total / 100).toFixed(2)}`,
    paid: response.status === 'paid',
  };
}
