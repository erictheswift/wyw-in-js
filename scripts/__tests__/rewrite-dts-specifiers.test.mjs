import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = resolve(__dirname, '../rewrite-dts-specifiers.mjs');

function writeFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const filename = join(root, name);
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, content);
  }
}

function runScript(packageRoot) {
  const result = spawnSync(process.execPath, [script], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

function withPackage(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'wyw-dts-specifiers-'));
  try {
    writeFiles(root, {
      'package.json': JSON.stringify({ name: 'pkg', type: 'module' }),
      ...files,
    });
    run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

test('adds .js to relative specifiers of declaration files', () => {
  withPackage(
    {
      'types/index.d.ts': [
        "import type { A } from './a';",
        "import { B } from '../types/b';",
        "export * from './a';",
        "export * as ns from './b';",
        "export { C } from './c.types';",
        "export type { D } from './utils';",
        'export type {',
        '  E,',
        "} from './utils/e';",
        "export type * from './a';",
        "export declare const f: import('./a').A;",
        "export type G = typeof import('./b');",
        '',
      ].join('\n'),
      'types/a.d.ts': 'export type A = 1;\n',
      'types/b.d.ts': 'export declare const B = 2;\n',
      'types/c.types.d.ts': 'export type C = 3;\n',
      'types/utils/index.d.ts': 'export type D = 4;\n',
      'types/utils/e.d.ts': 'export type E = 5;\n',
    },
    (root) => {
      runScript(root);

      assert.equal(
        readFileSync(join(root, 'types/index.d.ts'), 'utf8'),
        [
          "import type { A } from './a.js';",
          "import { B } from '../types/b.js';",
          "export * from './a.js';",
          "export * as ns from './b.js';",
          "export { C } from './c.types.js';",
          "export type { D } from './utils/index.js';",
          'export type {',
          '  E,',
          "} from './utils/e.js';",
          "export type * from './a.js';",
          "export declare const f: import('./a.js').A;",
          "export type G = typeof import('./b.js');",
          '',
        ].join('\n')
      );
    }
  );
});

test('prefers a file to a directory with the same name', () => {
  withPackage(
    {
      'types/index.d.ts': "export * from './cache';\n",
      'types/cache.d.ts': 'export type Cache = 1;\n',
      'types/cache/index.d.ts': 'export type Nested = 1;\n',
    },
    (root) => {
      runScript(root);

      assert.equal(
        readFileSync(join(root, 'types/index.d.ts'), 'utf8'),
        "export * from './cache.js';\n"
      );
    }
  );
});

test('keeps package, extension-bearing and query specifiers and is idempotent', () => {
  const source = [
    "import type { Plugin } from 'vite';",
    "import type { X } from '@scope/pkg/sub';",
    "export * from './a.js';",
    "export type { Data } from './data.json';",
    "export type { Raw } from './raw?raw';",
    '',
  ].join('\n');

  withPackage(
    {
      'types/index.d.ts': source,
      'types/a.d.ts': 'export type A = 1;\n',
    },
    (root) => {
      runScript(root);
      runScript(root);

      assert.equal(
        readFileSync(join(root, 'types/index.d.ts'), 'utf8'),
        source
      );
    }
  );
});

test('fails when the types directory is missing', () => {
  withPackage({}, (root) => {
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Types directory does not exist/);
  });
});
