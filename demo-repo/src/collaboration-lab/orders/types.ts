import type { CartItem, Quote } from '../pricing/types';
import type { CustomerId, OrderId } from '../shared/ids';

export type OrderStatus = 'pending' | 'paid' | 'cancelled';

export interface Order {
  id: OrderId;
  customerId: CustomerId;
  items: CartItem[];
  quote: Quote;
  status: OrderStatus;
  createdAt: number;
}
