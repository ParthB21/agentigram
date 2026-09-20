import type { ProductId } from '../shared/ids';
import type { NewProduct, Product } from './product';

export class ProductRepository {
  private readonly products = new Map<ProductId, Product>();

  save(input: NewProduct): Product {
    const product: Product = { ...input, active: input.active ?? true };
    this.products.set(product.id, product);
    return product;
  }

  find(id: ProductId): Product | undefined {
    return this.products.get(id);
  }

  list(): Product[] {
    return [...this.products.values()];
  }
}
