import type { ProductId } from '../shared/ids';

export interface StockItem {
  productId: ProductId;
  onHand: number;
  reserved: number;
}

export interface Reservation {
  productId: ProductId;
  quantity: number;
  remaining: number;
}

export function available(item: StockItem): number {
  return Math.max(0, item.onHand - item.reserved);
}
