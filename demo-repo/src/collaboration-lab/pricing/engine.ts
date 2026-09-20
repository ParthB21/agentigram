import type { ProductRepository } from '../catalog/repository';
import type { InventoryRepository } from '../inventory/repository';
import { available } from '../inventory/types';
import { addMoney, money } from '../shared/money';
import { bulkDiscount, type DiscountRule, memberDiscount } from './rules';
import type { CartItem, Quote, QuoteLine } from './types';

const DEFAULT_RULES = [bulkDiscount, memberDiscount];

export function quoteCart(
  items: CartItem[],
  products: ProductRepository,
  inventory: InventoryRepository,
  member = false,
  rules: DiscountRule[] = DEFAULT_RULES,
): Quote {
  const lines = items.map((item): QuoteLine => {
    const product = products.find(item.productId);
    if (!product?.active) throw new Error(`product unavailable: ${item.productId}`);
    if (available(inventory.require(item.productId)) < item.quantity) {
      throw new Error(`not enough inventory: ${item.productId}`);
    }
    const subtotalCents = product.price.cents * item.quantity;
    const discountCents = Math.min(
      subtotalCents,
      rules.reduce(
        (sum, rule) => sum + rule({ quantity: item.quantity, subtotalCents, member }),
        0,
      ),
    );
    return {
      ...item,
      unitPrice: product.price,
      subtotal: money(subtotalCents - discountCents, product.price.currency),
      discountCents,
    };
  });
  return {
    lines,
    total: lines.reduce(
      (total, line) => addMoney(total, line.subtotal),
      money(0, lines[0]?.subtotal.currency ?? 'CAD'),
    ),
  };
}
