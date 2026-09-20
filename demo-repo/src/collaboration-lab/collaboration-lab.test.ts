import { describe, expect, it } from 'vitest';
import { CatalogService } from './catalog/service';
import { sampleStore } from './fixtures';
import { available } from './inventory/types';
import { orderReceipt } from './notifications/receipt';
import { OrderRepository } from './orders/repository';
import { placeOrder } from './orders/service';
import { quoteCart } from './pricing/engine';
import { customerId, orderId } from './shared/ids';
import { estimateShipping } from './shipping/estimator';
import { toOrderView } from './ui/order-view';

describe('collaboration lab', () => {
  it('searches the catalog by name and tag', () => {
    const { products } = sampleStore();
    const catalog = new CatalogService(products);
    expect(catalog.search('desk')).toHaveLength(2);
    expect(catalog.search('keyboard').map((product) => product.name)).toEqual(['Glass Keyboard']);
  });

  it('quotes, reserves, and presents an order across domain boundaries', () => {
    const { products, inventory, keyboard, cable } = sampleStore();
    const quote = quoteCart(
      [
        { productId: keyboard.id, quantity: 1 },
        { productId: cable.id, quantity: 2 },
      ],
      products,
      inventory,
      true,
    );
    const order = placeOrder(
      { id: orderId('1001'), customerId: customerId('ada'), quote, createdAt: 1 },
      new OrderRepository(),
      inventory,
    );

    expect(quote.total.cents).toBe(10_450);
    expect(available(inventory.require(cable.id))).toBe(98);
    expect(estimateShipping(order, 'domestic').fee.cents).toBe(0);
    expect(orderReceipt(order).subject).toContain('order_1001');
    expect(toOrderView(order).statusLabel).toBe('PENDING');
  });

  it('rejects quotes that exceed available inventory', () => {
    const { products, inventory, keyboard } = sampleStore();
    expect(() =>
      quoteCart([{ productId: keyboard.id, quantity: 21 }], products, inventory),
    ).toThrow('not enough inventory');
  });
});
