import { type Admin, Color, Counter, LIMIT, double, helper } from './barrel';

export function describeAdmin(a: Admin): number {
  const { perms } = a;
  const made: Admin = { id: 1, perms: [] };
  const counter = new Counter(1);
  counter.inc();
  return a.id + perms.length + double(LIMIT) + (Color.Red as number) + Counter.create().inc() + helper() + made.id;
}
