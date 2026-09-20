import type { Product } from './product';
import type { ProductRepository } from './repository';

export class CatalogService {
  constructor(private readonly products: ProductRepository) {}

  search(query: string): Product[] {
    const term = query.trim().toLowerCase();
    return this.products
      .list()
      .filter((product) => product.active)
      .filter(
        (product) =>
          term.length === 0 ||
          product.name.toLowerCase().includes(term) ||
          product.tags.some((tag) => tag.toLowerCase().includes(term)),
      );
  }
}
