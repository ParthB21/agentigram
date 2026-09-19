import { z } from 'zod';

export const SYMBOL_KINDS = [
  'module',
  'class',
  'interface',
  'type',
  'enum',
  'function',
  'variable',
  'property',
  'method',
] as const;
export const SymbolKindSchema = z.enum(SYMBOL_KINDS);
export type SymbolKind = z.infer<typeof SymbolKindSchema>;

/** `<repo-relative path>#<ExportName>[.<member>]:<kind>` — build it only with `symbolKey`. */
export const SymbolKeySchema = z
  .string()
  .regex(/^[^#:]+#[^.:#]+(\.[^.:#]+)?:[a-z]+$/, 'bad symbol key');
export type SymbolKey = string;

export type ParsedSymbolKey = {
  path: string;
  exportName: string;
  member?: string;
  kind: SymbolKind;
};

export function symbolKey(path: string, exportName: string, kind: SymbolKind): SymbolKey;
export function symbolKey(
  path: string,
  exportName: string,
  member: string | undefined,
  kind: SymbolKind,
): SymbolKey;
export function symbolKey(
  path: string,
  exportName: string,
  a: string | undefined,
  b?: SymbolKind,
): SymbolKey {
  const kind = SymbolKindSchema.parse(b ?? a);
  const member = b === undefined ? undefined : a;
  const normalised = path.replaceAll('\\', '/').replace(/^\.\//, '');
  for (const part of [normalised, exportName, member ?? 'x']) {
    if (part.length === 0 || /[#:]/.test(part)) throw new Error(`invalid symbol key part: ${part}`);
  }
  if (exportName.includes('.') || member?.includes('.')) {
    throw new Error('exportName and member must not contain "."');
  }
  return `${normalised}#${exportName}${member ? `.${member}` : ''}:${kind}`;
}

export function parseSymbolKey(key: SymbolKey): ParsedSymbolKey {
  SymbolKeySchema.parse(key);
  const hash = key.indexOf('#');
  const colon = key.lastIndexOf(':');
  const [exportName = '', member] = key.slice(hash + 1, colon).split('.');
  return {
    path: key.slice(0, hash),
    exportName,
    ...(member ? { member } : {}),
    kind: SymbolKindSchema.parse(key.slice(colon + 1)),
  };
}
