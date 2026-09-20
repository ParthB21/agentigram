import type { Order } from '../orders/types';

export interface OrderMetrics {
  orders: number;
  grossCents: number;
  averageCents: number;
  paidRate: number;
}

export function calculateOrderMetrics(orders: Order[]): OrderMetrics {
  const grossCents = orders.reduce((sum, order) => sum + order.quote.total.cents, 0);
  const paid = orders.filter((order) => order.status === 'paid').length;
  return {
    orders: orders.length,
    grossCents,
    averageCents: orders.length === 0 ? 0 : Math.round(grossCents / orders.length),
    paidRate: orders.length === 0 ? 0 : paid / orders.length,
  };
}
