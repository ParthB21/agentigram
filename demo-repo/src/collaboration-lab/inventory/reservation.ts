import type { ProductId } from '../shared/ids';
import type { InventoryRepository } from './repository';
import { available, type Reservation } from './types';

export function reserveStock(
  inventory: InventoryRepository,
  productId: ProductId,
  quantity: number,
): Reservation {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('quantity must be positive');
  const item = inventory.require(productId);
  if (available(item) < quantity) throw new Error(`insufficient stock for ${productId}`);
  item.reserved += quantity;
  return { productId, quantity, remaining: available(item) };
}
