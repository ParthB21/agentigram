import type { AuthResponse } from '../auth/types';
import type { UserService } from '../users/service';
import type { FakeStripe } from './stripe';
import type { Cart, CheckoutResponse, Order } from './types';

export interface CheckoutDeps {
  users: UserService;
  stripe: FakeStripe;
  nextSequence: () => number;
}

export function cartTotal(cart: Cart): number {
  return cart.items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
}

export function checkout(auth: AuthResponse, cart: Cart, deps: CheckoutDeps): CheckoutResponse {
  const user = deps.users.requireUser(auth.userId);
  const total = cartTotal(cart);

  const charge = deps.stripe.chargeCustomer(user.id, total);
  const orderNumber: number = user.id * 1_000_000 + deps.nextSequence();
  const order: Order = {
    id: `ord_${orderNumber}`,
    userId: user.id,
    total,
    chargeId: charge.id,
  };

  return {
    orderId: order.id,
    userId: order.userId,
    total: order.total,
    status: charge.status === 'succeeded' ? 'paid' : 'failed',
  };
}
