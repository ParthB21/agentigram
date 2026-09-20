import type { ProductId } from '../shared/ids';
import type { Money } from '../shared/money';

export interface Product {
  id: ProductId;
  name: string;
  price: Money;
  tags: string[];
  active: boolean;
}

export type NewProduct = Omit<Product, 'active'> & { active?: boolean };
