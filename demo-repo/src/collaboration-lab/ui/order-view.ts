import type { Order } from '../orders/types';
import { formatMoney } from '../shared/money';

export interface OrderView {
  id: string;
  headline: string;
  statusLabel: string;
}

export function toOrderView(order: Order): OrderView {
  return {
    id: order.id,
    headline: `${order.items.length} item types · ${formatMoney(order.quote.total)}`,
    statusLabel: order.status.toUpperCase(),
  };
}
