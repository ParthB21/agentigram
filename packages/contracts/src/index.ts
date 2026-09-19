import { createHash } from 'node:crypto';
import type { Contract } from '@agentigram/protocol';

export type CheckFile = { path: string; content: string };
export type CompiledContract = { contractId: string; checkFiles: CheckFile[] };

/** Everything `verifyRun` needs; assembled by the coordinator from hooks, GitHub and the ledger. */
export type RunEvidence = {
  runId: string;
  sessionId: string;
  declaredComplete: boolean;
  commitsWithTrailer: number;
  requiredCiGreen: boolean;
  contractsPass: boolean;
  humanTakeover: boolean;
};
export type RunVerdict = { verified: boolean; reasons: string[] };

export function compile(contract: Contract): CompiledContract {
  const canonical = JSON.stringify({
    symbol: contract.symbol,
    kind: contract.kind,
    before: contract.before,
    after: contract.after,
    constraint: contract.constraint ?? null,
    migration: contract.migration ?? null,
  });
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  const contractId = `contract-${digest}`;
  const slug = contract.symbol
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 64);
  const path = `.agentigram/contracts/${slug}-${digest}.contract.ts`;
  return { contractId, checkFiles: [{ path, content: compileCheck(contract, contractId) }] };
}

/** Pure: the reducer calls this to decide whether to emit RUN_VERIFIED. */
export function verifyRun(evidence: RunEvidence): RunVerdict {
  const reasons: string[] = [];
  if (!evidence.declaredComplete) reasons.push('completion was not declared');
  if (evidence.commitsWithTrailer < 1) reasons.push('no commit is attributed to this run');
  if (!evidence.requiredCiGreen) reasons.push('required CI is not green');
  if (!evidence.contractsPass) reasons.push('contract checks did not pass');
  if (evidence.humanTakeover) reasons.push('a human took over the run');
  return { verified: reasons.length === 0, reasons };
}

function compileCheck(contract: Contract, contractId: string): string {
  const parsed = parseSymbol(contract.symbol);
  const target = parsed.member ? `Imported['${escapeTypeKey(parsed.member)}']` : 'Imported';
  const expected = normalizeType(contract.after);
  const relativeImport = `../../${parsed.module.replace(/\.[cm]?[jt]sx?$/, '.js')}`;
  const metadata = JSON.stringify({
    id: contractId,
    symbol: contract.symbol,
    kind: contract.kind,
    constraint: contract.constraint ?? null,
    migration: contract.migration ?? null,
  });
  if (contract.kind === 'type') {
    return [
      `// Generated deterministically by Agentigram. ${metadata}`,
      `import type { ${parsed.exportName} as Imported } from '${relativeImport}';`,
      'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)',
      '  ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false',
      '  : false;',
      'type Assert<T extends true> = T;',
      `type ContractCheck = Assert<Equal<${target}, ${expected}>>;`,
      'export type { ContractCheck };',
      '',
    ].join('\n');
  }
  // Shape and HTTP contracts are still compiler-enforced: `after` is the agreed TS shape.
  return [
    `// Generated deterministically by Agentigram. ${metadata}`,
    `import type { ${parsed.exportName} as Imported } from '${relativeImport}';`,
    `type Expected = ${expected};`,
    `const actualToExpected = (value: ${target}): Expected => value;`,
    `const expectedToActual = (value: Expected): ${target} => value;`,
    'void actualToExpected;',
    'void expectedToActual;',
    '',
  ].join('\n');
}

function parseSymbol(symbol: string): { module: string; exportName: string; member?: string } {
  const hash = symbol.indexOf('#');
  if (hash <= 0 || hash === symbol.length - 1)
    throw new Error(`Invalid contract symbol: ${symbol}`);
  const module = symbol.slice(0, hash);
  const qualified = symbol.slice(hash + 1).replace(/:[a-z]+$/, '');
  const dot = qualified.indexOf('.');
  const exportName = dot < 0 ? qualified : qualified.slice(0, dot);
  const member = dot < 0 ? undefined : qualified.slice(dot + 1);
  if (!/^[$A-Z_a-z][$\w]*$/.test(exportName) || (member && member.length === 0)) {
    throw new Error(`Invalid contract symbol: ${symbol}`);
  }
  return { module, exportName, ...(member ? { member } : {}) };
}

function normalizeType(value: string): string {
  const trimmed = value.trim().replace(/;$/, '');
  const property = trimmed.match(/^(?:readonly\s+)?[^:]+\??:\s*(.+)$/s);
  return property?.[1] ?? trimmed;
}

function escapeTypeKey(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}
