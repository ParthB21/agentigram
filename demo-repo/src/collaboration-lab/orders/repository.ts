import type { OrderId } from '../shared/ids';
import type { Order } from './types';

export class OrderRepository {
  private readonly orders = new Map<OrderId, Order>();

  save(order: Order): Order {
    this.orders.set(order.id, order);
    return order;
  }

  require(id: OrderId): Order {
    const order = this.orders.get(id);
    if (!order) throw new Error(`order not found: ${id}`);
    return order;
  }

  list(): Order[] {
    return [...this.orders.values()];
  }
}
