import ts from 'typescript';
import type { Ctx } from './extract.js';
import type { Reference } from './types.js';

/** Symbols an identifier may denote: its own, its alias target, and the contextual property. */
function candidates(checker: ts.TypeChecker, id: ts.Identifier): ts.Symbol[] {
  const out: ts.Symbol[] = [];
  const sym = checker.getSymbolAtLocation(id);
  if (sym) {
    try {
      out.push(sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym);
    } catch {
      // unresolved alias (missing module): nothing to point at
    }
  }
  const parent = id.parent;
  // `{ id: 1 }` / `{ id }` typed as User: the literal's own property is not User.id.
  if (
    (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) &&
    parent.name === id &&
    ts.isObjectLiteralExpression(parent.parent)
  ) {
    const ctxType = checker.getContextualType(parent.parent);
    const prop = ctxType?.getProperty(id.text);
    if (prop) out.push(prop);
  }
  // `const { id } = user`: the binding is a new variable; the property is on the pattern's type.
  if (
    ts.isBindingElement(parent) &&
    parent.name === id &&
    !parent.propertyName &&
    ts.isObjectBindingPattern(parent.parent)
  ) {
    const prop = checker.getTypeAtLocation(parent.parent).getProperty(id.text);
    if (prop) out.push(prop);
  }
  return out;
}

/** External references in `sf`: uses of indexed symbols declared in *other* modules. */
export function collectReferences(ctx: Ctx, sf: ts.SourceFile): Reference[] {
  const path = ctx.rel(sf.fileName);
  const seen = new Set<string>();
  const out: Reference[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      for (const sym of candidates(ctx.checker, node)) {
        for (const decl of sym.declarations ?? []) {
          if (decl.getSourceFile() === sf) continue;
          for (const key of ctx.declKeys.get(decl) ?? []) {
            const id = `${line}|${key}`;
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ key, path, line });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out.sort((a, b) => a.line - b.line || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Repo modules imported or re-exported by `sf`, resolved with the repo's own tsconfig. */
export function collectImports(
  sf: ts.SourceFile,
  options: ts.CompilerOptions,
  host: ts.ModuleResolutionHost,
  ctx: Pick<Ctx, 'rel' | 'isRepoFile'>,
): string[] {
  const specs: string[] = [];
  for (const st of sf.statements) {
    if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier) {
      if (ts.isStringLiteral(st.moduleSpecifier)) specs.push(st.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(st) &&
      ts.isExternalModuleReference(st.moduleReference) &&
      ts.isStringLiteral(st.moduleReference.expression)
    ) {
      specs.push(st.moduleReference.expression.text);
    }
  }
  const resolved = new Set<string>();
  for (const spec of specs) {
    const r = ts.resolveModuleName(spec, sf.fileName, options, host).resolvedModule;
    if (!r || r.isExternalLibraryImport) continue;
    const abs = r.resolvedFileName.replaceAll('\\', '/');
    if (ctx.isRepoFile(abs) && !abs.endsWith('.d.ts')) resolved.add(ctx.rel(abs));
  }
  return [...resolved].sort();
}
