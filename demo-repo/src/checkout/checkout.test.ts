import { describe, expect, it } from 'vitest';
import type { AuthResponse } from '../auth/types';
import { UserRepository } from '../users/repository';
import { UserService } from '../users/service';
import { cartTotal, checkout } from './checkout';
import { customerRef, FakeStripe } from './stripe';
import { toViewModel } from './view-model';

const cart = {
  items: [
    { sku: 'a', quantity: 2, unitPriceCents: 500 },
    { sku: 'b', quantity: 1, unitPriceCents: 250 },
  ],
};

function setup(limitCents?: number) {
  const users = new UserService(new UserRepository());
  const user = users.register({ email: 'a@x.dev', name: 'A' });
  const auth: AuthResponse = { token: 't', userId: user.id, expiresAt: 0 };
  return { auth, deps: { users, stripe: new FakeStripe(limitCents), nextSequence: () => 42 } };
}

describe('checkout', () => {
  it('totals a cart', () => {
    expect(cartTotal(cart)).toBe(1250);
  });

  it('charges the authenticated user and returns a paid order', () => {
    const { auth, deps } = setup();
    const res = checkout(auth, cart, deps);
    expect(res).toEqual({
      orderId: 'ord_1000042',
      userId: auth.userId,
      total: 1250,
      status: 'paid',
    });
  });

  it('reports a declined charge as failed', () => {
    const { auth, deps } = setup(100);
    expect(checkout(auth, cart, deps).status).toBe('failed');
  });

  it('fails for an unknown user', () => {
    const { deps } = setup();
    expect(() => checkout({ token: 't', userId: 99, expiresAt: 0 }, cart, deps)).toThrow(
      'not found',
    );
  });
});

describe('stripe and view model', () => {
  it('builds a customer reference', () => {
    expect(customerRef(35)).toBe('cus_z');
  });

  it('formats the checkout response for the UI', () => {
    expect(toViewModel({ orderId: 'o', userId: 1, total: 1250, status: 'paid' })).toEqual({
      orderId: 'o',
      customerId: 1,
      totalLabel: '$12.50',
      paid: true,
    });
  });
});
