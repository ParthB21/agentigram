import { createHash } from 'node:crypto';
import { type SymbolKey, type SymbolKind, symbolKey } from '@agentigram/protocol';
import ts from 'typescript';
import type { IndexedSymbol } from './types.js';

export type Ctx = {
  checker: ts.TypeChecker;
  rel(abs: string): string;
  isRepoFile(abs: string): boolean;
  /**
   * Declaration node -> keys, for every indexed symbol and member. A node can have several: an
   * inherited member is one declaration but part of every subtype's surface (Base.id, Admin.id).
   */
  declKeys: Map<ts.Node, SymbolKey[]>;
};

/** Stable type printing: no truncation, arrow-style signatures, single quotes, no absolute paths. */
export const TYPE_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
  ts.TypeFormatFlags.WriteArrowStyleSignature |
  ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;

export const hashSignature = (s: string) =>
  createHash('sha256').update(s).digest('hex').slice(0, 16);
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

function kindOf(checker: ts.TypeChecker, target: ts.Symbol, decl: ts.Declaration): SymbolKind {
  if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) return 'class';
  if (ts.isInterfaceDeclaration(decl)) return 'interface';
  if (ts.isTypeAliasDeclaration(decl)) return 'type';
  if (ts.isEnumDeclaration(decl)) return 'enum';
  if (ts.isFunctionDeclaration(decl)) return 'function';
  if (ts.isModuleDeclaration(decl)) return 'module';
  const type = checker.getTypeOfSymbolAtLocation(target, decl);
  return type.getCallSignatures().length > 0 ? 'function' : 'variable';
}

function typeParams(node: { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }): string {
  return node.typeParameters
    ? `<${node.typeParameters.map((t) => squash(t.getText())).join(', ')}>`
    : '';
}

function heritage(node: ts.ClassDeclaration | ts.InterfaceDeclaration): string {
  return (node.heritageClauses ?? [])
    .map(
      (h) =>
        `${h.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements'} ${h.types
          .map((t) => squash(t.getText()))
          .join(', ')}`,
    )
    .join(' ');
}

function topSignature(ctx: Ctx, target: ts.Symbol, decl: ts.Declaration, kind: SymbolKind): string {
  const { checker } = ctx;
  const name = target.getName();
  switch (kind) {
    case 'class': {
      const c = decl as ts.ClassDeclaration;
      const abstract = c.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)
        ? 'abstract '
        : '';
      return squash(`${abstract}class ${name}${typeParams(c)} ${heritage(c)}`);
    }
    case 'interface': {
      const i = decl as ts.InterfaceDeclaration;
      return squash(`interface ${name}${typeParams(i)} ${heritage(i)}`);
    }
    case 'type': {
      const t = decl as ts.TypeAliasDeclaration;
      const body = checker.typeToString(
        checker.getDeclaredTypeOfSymbol(target),
        undefined,
        TYPE_FLAGS | ts.TypeFormatFlags.InTypeAlias,
      );
      return `type ${name}${typeParams(t)} = ${body}`;
    }
    case 'enum':
      return `${ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Const ? 'const ' : ''}enum ${name}`;
    case 'module':
      return `namespace ${name}`;
    default:
      return checker.typeToString(
        checker.getTypeOfSymbolAtLocation(target, decl),
        undefined,
        TYPE_FLAGS,
      );
  }
}

const declLine = (decl: ts.Declaration) => {
  const at = ts.getNameOfDeclaration(decl) ?? decl;
  return decl.getSourceFile().getLineAndCharacterOfPosition(at.getStart()).line + 1;
};

function isPrivate(decl: ts.Declaration): boolean {
  const name = ts.getNameOfDeclaration(decl);
  return (
    (name !== undefined && ts.isPrivateIdentifier(name)) ||
    (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Private) !== 0
  );
}

/** Members declared in this repo (not lib/node_modules), excluding private ones. */
function repoMembers(ctx: Ctx, props: ts.Symbol[]): ts.Symbol[] {
  return props.filter((p) => {
    const decls = p.declarations ?? [];
    return (
      decls.length > 0 &&
      decls.every((d) => !isPrivate(d)) &&
      decls.some((d) => ctx.isRepoFile(d.getSourceFile().fileName))
    );
  });
}

function memberSignature(
  ctx: Ctx,
  m: ts.Symbol,
  decl: ts.Declaration,
  enumMember: boolean,
): string {
  const { checker } = ctx;
  if (enumMember && ts.isEnumMember(decl)) {
    const value = checker.getConstantValue(decl);
    return `${m.getName()} = ${typeof value === 'string' ? `'${value}'` : String(value)}`;
  }
  const type = checker.getTypeOfSymbolAtLocation(m, decl);
  const readonly = ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Readonly ? 'readonly ' : '';
  const optional = m.flags & ts.SymbolFlags.Optional ? '?' : '';
  return `${readonly}${m.getName()}${optional}: ${checker.typeToString(type, undefined, TYPE_FLAGS)}`;
}

/** Exported symbols (and their members) *declared* in `sf`; re-exports live where they are declared. */
export function extractModule(ctx: Ctx, sf: ts.SourceFile): IndexedSymbol[] {
  const { checker } = ctx;
  const modSym = checker.getSymbolAtLocation(sf);
  if (!modSym) return [];
  const path = ctx.rel(sf.fileName);
  const out: IndexedSymbol[] = [];

  const push = (
    exportName: string,
    member: string | undefined,
    kind: SymbolKind,
    signature: string,
    decls: readonly ts.Declaration[],
  ) => {
    const key = member
      ? symbolKey(path, exportName, member, kind)
      : symbolKey(path, exportName, kind);
    for (const d of decls) {
      const keys = ctx.declKeys.get(d) ?? [];
      if (!keys.includes(key)) ctx.declKeys.set(d, [...keys, key]);
    }
    out.push({
      key,
      kind,
      path,
      exportName,
      ...(member ? { member } : {}),
      signature,
      signatureHash: hashSignature(signature),
      line: declLine(decls[0] as ts.Declaration),
    });
  };

  for (const exp of checker.getExportsOfModule(modSym)) {
    const target = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
    const decls = target.declarations ?? [];
    const decl = decls[0];
    if (!decl || decl.getSourceFile() !== sf) continue;
    const exportName = exp.getName();
    const kind = kindOf(checker, target, decl);
    push(exportName, undefined, kind, topSignature(ctx, target, decl, kind), decls);

    if (kind === 'class' || kind === 'interface' || kind === 'type' || kind === 'enum') {
      const declared = checker.getDeclaredTypeOfSymbol(target);
      const objectLike =
        kind === 'enum' ||
        (!declared.isUnion() && declared.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection));
      if (objectLike) {
        const props =
          kind === 'enum'
            ? checker.getPropertiesOfType(checker.getTypeOfSymbolAtLocation(target, decl))
            : checker.getPropertiesOfType(declared);
        for (const m of repoMembers(ctx, props)) {
          const md = m.declarations as ts.Declaration[];
          const mkind: SymbolKind = md.some(
            (d) => ts.isMethodDeclaration(d) || ts.isMethodSignature(d),
          )
            ? 'method'
            : 'property';
          push(
            exportName,
            m.getName(),
            mkind,
            memberSignature(ctx, m, md[0] as ts.Declaration, kind === 'enum'),
            md,
          );
        }
      }
      if (kind === 'class') classExtras(ctx, target, decl as ts.ClassDeclaration, push, exportName);
    }
  }
  return out;
}

/** Explicit constructors and static members of a class. Statics are keyed `static$<name>`. */
function classExtras(
  ctx: Ctx,
  target: ts.Symbol,
  decl: ts.ClassDeclaration,
  push: (
    e: string,
    m: string | undefined,
    k: SymbolKind,
    s: string,
    d: readonly ts.Declaration[],
  ) => void,
  exportName: string,
): void {
  const { checker } = ctx;
  const ctorType = checker.getTypeOfSymbolAtLocation(target, decl);
  const own = ctorType
    .getConstructSignatures()
    .filter((s) => s.declaration && s.declaration.parent === decl);
  if (own.length > 0) {
    const text = own
      .map((s) => checker.signatureToString(s, decl, TYPE_FLAGS, ts.SignatureKind.Construct))
      .join(' & ');
    push(
      exportName,
      'constructor',
      'method',
      text,
      own.map((s) => s.declaration as ts.Declaration),
    );
  }
  for (const m of repoMembers(ctx, checker.getPropertiesOfType(ctorType))) {
    if (m.getName() === 'prototype') continue;
    const md = m.declarations as ts.Declaration[];
    const isMethod = md.some((d) => ts.isMethodDeclaration(d));
    const first = md[0] as ts.Declaration;
    push(
      exportName,
      `static$${m.getName()}`,
      isMethod ? 'method' : 'property',
      `static ${memberSignature(ctx, m, first, false)}`,
      md,
    );
  }
}
