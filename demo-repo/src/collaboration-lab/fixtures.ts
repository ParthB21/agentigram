import { ProductRepository } from './catalog/repository';
import { InventoryRepository } from './inventory/repository';
import { productId } from './shared/ids';
import { money } from './shared/money';

export function sampleStore() {
  const products = new ProductRepository();
  const inventory = new InventoryRepository();
  const keyboard = products.save({
    id: productId('keyboard'),
    name: 'Glass Keyboard',
    price: money(8000),
    tags: ['desk', 'input'],
  });
  const cable = products.save({
    id: productId('cable'),
    name: 'Braided Cable',
    price: money(1500),
    tags: ['desk', 'accessory'],
  });
  inventory.set({ productId: keyboard.id, onHand: 20, reserved: 0 });
  inventory.set({ productId: cable.id, onHand: 100, reserved: 0 });
  return { products, inventory, keyboard, cable };
}
