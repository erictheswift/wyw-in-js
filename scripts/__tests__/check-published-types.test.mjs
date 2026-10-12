import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const checkScript = resolve(__dirname, '../check-published-types.mjs');
const rewriteScript = resolve(__dirname, '../rewrite-dts-specifiers.mjs');

function writeFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const filename = join(root, name);
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, content);
  }
}

function withWorkspace(run) {
  const root = mkdtempSync(join(tmpdir(), 'wyw-published-types-'));
  try {
    writeFiles(root, {
      'packages/lib/package.json': JSON.stringify({
        name: '@example/lib',
        type: 'module',
        exports: {
          '.': { types: './types/index.d.ts', default: './esm/index.js' },
        },
      }),
      'packages/lib/types/index.d.ts': [
        "export * from './values';",
        "export type { Options } from './options';",
        '',
      ].join('\n'),
      'packages/lib/types/values.d.ts': 'export declare const value: 1;\n',
      'packages/lib/types/options/index.d.ts':
        'export type Options = { debug: boolean };\n',
      'packages/private/package.json': JSON.stringify({
        name: '@example/private',
        private: true,
        type: 'module',
        exports: { '.': { types: './types/index.d.ts' } },
      }),
      'packages/private/types/index.d.ts': "export * from './missing';\n",
    });
    run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', ...options });
}

test('reports extensionless relative imports under node16 and nodenext', () => {
  withWorkspace((root) => {
    const result = runNode([checkScript, root]);

    assert.equal(result.status, 1);
    // TS2834/TS2835: relative imports need explicit file extensions.
    assert.match(
      result.stderr,
      /\[node16\] packages\/lib\/types\/index\.d\.ts:1:\d+ TS283[45]/
    );
    assert.match(
      result.stderr,
      /\[nodenext\] packages\/lib\/types\/index\.d\.ts:2:\d+ TS283[45]/
    );
    assert.doesNotMatch(result.stderr, /\[bundler\]|\[node10\]/);
    assert.doesNotMatch(result.stderr, /packages\/private/);
  });
});

test('passes once the declaration files import with extensions', () => {
  withWorkspace((root) => {
    const rewrite = runNode([rewriteScript], {
      cwd: join(root, 'packages/lib'),
    });
    assert.equal(rewrite.status, 0, rewrite.stderr);

    const result = runNode([checkScript, root]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Checked 3 declaration files of 1 packages under node16, nodenext, bundler, node10/
    );
  });
});

test('reports a package whose exported types do not exist', () => {
  withWorkspace((root) => {
    writeFiles(root, {
      'packages/lib/package.json': JSON.stringify({
        name: '@example/lib',
        type: 'module',
        exports: {
          '.': { types: './types/main.d.ts', default: './esm/index.js' },
        },
      }),
    });
    runNode([rewriteScript], { cwd: join(root, 'packages/lib') });

    const result = runNode([checkScript, root]);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /\[node16\] @example\/lib resolves to nothing instead of packages\/lib\/types\/main\.d\.ts/
    );
  });
});
