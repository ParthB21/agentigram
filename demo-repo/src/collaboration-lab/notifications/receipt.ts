import type { Order } from '../orders/types';
import { formatMoney } from '../shared/money';

export interface ReceiptMessage {
  subject: string;
  body: string;
}

export function orderReceipt(order: Order): ReceiptMessage {
  return {
    subject: `Order ${order.id} received`,
    body: `${order.items.length} item types · ${formatMoney(order.quote.total)} · ${order.status}`,
  };
}
