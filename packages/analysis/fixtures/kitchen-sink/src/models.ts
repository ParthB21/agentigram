export interface Base {
  id: number;
}

export interface Admin extends Base {
  perms: string[];
  readonly tag?: string;
}

export type Point = { x: number; y?: number };
export type Mode = 'fast' | 'slow';
export type Mapper<T> = (input: T) => T;

export enum Color {
  Red,
  Green = 'green',
}

export const enum Flag {
  On = 1,
}

export class Counter {
  static instances = 0;
  readonly label: string;
  protected step: number;
  private secret = 1;
  #hidden = 2;

  constructor(start: number, label = 'c') {
    this.label = label;
    this.step = start;
  }

  inc(by?: number): number {
    return this.step + (by ?? 1) + this.secret + this.#hidden;
  }

  static create(): Counter {
    return new Counter(0);
  }
}

export abstract class Shape {
  abstract area(): number;
}

export function parse(s: string): number;
export function parse(s: number): string;
export function parse(s: string | number): number | string {
  return typeof s === 'string' ? Number(s) : String(s);
}

export function identity<T>(x: T): T {
  return x;
}

export const double = (n: number): number => n * 2;
export const LIMIT = 10;

export default function main(): void {}

const hidden = 1;
export { hidden as visible };

export namespace Util {
  export const x = 1;
}

const notExported = 5;
void notExported;
