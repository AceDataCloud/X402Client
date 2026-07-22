import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const typescriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(typescriptRoot, '..');
const scriptsRoot = join(typescriptRoot, 'scripts');
const publicDocuments = [
  join(repositoryRoot, 'README.md'),
  join(repositoryRoot, 'examples', 'README.md'),
  join(repositoryRoot, 'docs', 'SKALE_DEMO.md'),
  join(repositoryRoot, 'docs', 'UPTO_DEMO.md'),
  join(repositoryRoot, 'java', 'src', 'main', 'java', 'cloud', 'acedata', 'x402', 'X402PaymentEnvelope.java'),
  join(repositoryRoot, 'python', 'README.md'),
  join(typescriptRoot, 'README.md'),
];

function readScripts(): string {
  return readdirSync(scriptsRoot)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(join(scriptsRoot, name), 'utf8'))
    .join('\n');
}

describe('official v2 examples', () => {
  it('does not promote the legacy payment header', () => {
    const content = [readScripts(), ...publicDocuments.map((path) => readFileSync(path, 'utf8'))].join('\n');
    const legacyHeader = ['X', 'Payment'].join('-');

    expect(content).not.toContain(legacyHeader);
    expect(content).toContain('PAYMENT-SIGNATURE');
  });

  it('selects payment requirements by canonical network IDs', () => {
    const content = readScripts();

    expect(content).toContain('eip155:8453');
    expect(content).toContain('eip155:1187947933');
    expect(content).toContain('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(content).not.toMatch(/\.network\s*===\s*['"](?:base|skale|solana)['"]/);
  });
});