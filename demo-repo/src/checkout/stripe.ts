export interface Charge {
  id: string;
  customerId: number;
  amountCents: number;
  status: 'succeeded' | 'declined';
}

/** Stripe customer reference for one of our users. */
export function customerRef(customerId: number): string {
  return `cus_${customerId.toString(36)}`;
}

/** Deterministic fake: declines anything over the limit. Stands in for the real Stripe client. */
export class FakeStripe {
  private count = 0;

  constructor(private readonly limitCents: number = 100_000) {}

  chargeCustomer(customerId: number, amountCents: number): Charge {
    this.count++;
    return {
      id: `ch_${this.count}`,
      customerId,
      amountCents,
      status: amountCents <= this.limitCents ? 'succeeded' : 'declined',
    };
  }
}
