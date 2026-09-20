import type { Order } from '../orders/types';
import { money } from '../shared/money';
import type { ShipmentEstimate, ShippingZone } from './types';

const ZONE_RULES: Record<ShippingZone, { cents: number; days: number }> = {
  local: { cents: 500, days: 1 },
  domestic: { cents: 1200, days: 4 },
  international: { cents: 3000, days: 10 },
};

export function estimateShipping(order: Order, zone: ShippingZone): ShipmentEstimate {
  const rule = ZONE_RULES[zone];
  const free = zone !== 'international' && order.quote.total.cents >= 10_000;
  return {
    orderId: order.id,
    zone,
    fee: money(free ? 0 : rule.cents, order.quote.total.currency),
    businessDays: rule.days,
  };
}
