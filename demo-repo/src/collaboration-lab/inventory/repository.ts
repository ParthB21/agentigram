import type { ProductId } from '../shared/ids';
import type { StockItem } from './types';

export class InventoryRepository {
  private readonly items = new Map<ProductId, StockItem>();

  set(item: StockItem): void {
    this.items.set(item.productId, { ...item });
  }

  require(productId: ProductId): StockItem {
    const item = this.items.get(productId);
    if (!item) throw new Error(`stock missing for ${productId}`);
    return item;
  }
}
