import type { InventoryRepository } from '../inventory/repository';
import { reserveStock } from '../inventory/reservation';
import type { Quote } from '../pricing/types';
import type { CustomerId, OrderId } from '../shared/ids';
import type { OrderRepository } from './repository';
import type { Order } from './types';

export interface PlaceOrderInput {
  id: OrderId;
  customerId: CustomerId;
  quote: Quote;
  createdAt: number;
}

export function placeOrder(
  input: PlaceOrderInput,
  orders: OrderRepository,
  inventory: InventoryRepository,
): Order {
  for (const line of input.quote.lines) {
    reserveStock(inventory, line.productId, line.quantity);
  }
  return orders.save({
    ...input,
    items: input.quote.lines.map(({ productId, quantity }) => ({ productId, quantity })),
    status: 'pending',
  });
}
