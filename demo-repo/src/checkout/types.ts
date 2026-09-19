export interface LineItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Cart {
  items: LineItem[];
}

export interface Order {
  id: string;
  userId: number;
  total: number;
  chargeId: string;
}

export interface CheckoutResponse {
  orderId: string;
  userId: number;
  total: number;
  status: 'paid' | 'failed';
}
