#!/usr/bin/env node

// tsc keeps relative specifiers as written in the sources, so the declaration
// files import `./a` while the ESM build imports `./a.js`. Node16/NodeNext
// resolution treats the declaration files of a `"type": "module"` package as
// ESM and cannot resolve extensionless relative imports, so re-exported types
// are lost. Run after tsc in `build:types` to add the extensions the same way
// build-esm-oxc.mjs does for the runtime files. A declaration file always
// imports `.js`: TypeScript maps it to the sibling `.d.ts`.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { argv, cwd, exit } from 'node:process';

import { globSync } from 'glob';

import { rewriteRelativeSpecifiers } from './helpers/relative-specifiers.mjs';

const typesDir = path.resolve(cwd(), parseTypesDir(argv.slice(2)));

if (!existsSync(typesDir)) {
  console.error(`Types directory does not exist: ${typesDir}`);
  exit(1);
}

const files = globSync('**/*.d.ts', {
  absolute: true,
  cwd: typesDir,
  nodir: true,
}).sort();

for (const filename of files) {
  const code = readFileSync(filename, 'utf8');
  const rewritten = rewriteRelativeSpecifiers(code, filename, {
    extension: '.js',
    resolveExtensions: ['.d.ts'],
  });

  if (rewritten !== code) {
    writeFileSync(filename, rewritten);
  }
}

function parseTypesDir(args) {
  if (args.length === 0) {
    return 'types';
  }

  if (args.length === 2 && args[0] === '--types-dir' && args[1]) {
    return args[1];
  }

  throw new Error(`Unknown arguments: ${args.join(' ')}`);
}
