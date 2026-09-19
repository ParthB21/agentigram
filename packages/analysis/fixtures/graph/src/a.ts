import './side-effect';
import type { D } from './d';
import { fromB } from './lib';

export const a = fromB + 1;
export type FromD = D;
