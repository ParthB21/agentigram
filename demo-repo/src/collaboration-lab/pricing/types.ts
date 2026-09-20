import type { ProductId } from '../shared/ids';
import type { Money } from '../shared/money';

export interface CartItem {
  productId: ProductId;
  quantity: number;
}

export interface QuoteLine extends CartItem {
  unitPrice: Money;
  subtotal: Money;
  discountCents: number;
}

export interface Quote {
  lines: QuoteLine[];
  total: Money;
}
