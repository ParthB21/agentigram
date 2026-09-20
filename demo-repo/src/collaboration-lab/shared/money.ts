export type Currency = 'CAD' | 'USD';

export interface Money {
  cents: number;
  currency: Currency;
}

export function money(cents: number, currency: Currency = 'CAD'): Money {
  if (!Number.isInteger(cents) || cents < 0) throw new Error('money must use non-negative cents');
  return { cents, currency };
}

export function addMoney(left: Money, right: Money): Money {
  if (left.currency !== right.currency) throw new Error('currency mismatch');
  return money(left.cents + right.cents, left.currency);
}

export function formatMoney(value: Money): string {
  return `${value.currency} $${(value.cents / 100).toFixed(2)}`;
}
