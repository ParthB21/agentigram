import type { OrderId } from '../shared/ids';
import type { Money } from '../shared/money';

export type ShippingZone = 'local' | 'domestic' | 'international';

export interface ShipmentEstimate {
  orderId: OrderId;
  zone: ShippingZone;
  fee: Money;
  businessDays: number;
}
