export type ProductId = `prod_${string}`;
export type CustomerId = `cust_${string}`;
export type OrderId = `order_${string}`;

export function productId(value: string): ProductId {
  return `prod_${value}`;
}

export function customerId(value: string): CustomerId {
  return `cust_${value}`;
}

export function orderId(value: string): OrderId {
  return `order_${value}`;
}
