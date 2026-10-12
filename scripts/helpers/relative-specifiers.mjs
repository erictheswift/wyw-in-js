import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const KNOWN_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.txt',
  '.md',
  '.wasm',
  '.node',
]);

const SPECIFIER_PATTERNS = [
  // import x from './a', import type { X } from './a', import './a'
  /(\bimport\s+(?:[^'"]*?\s+from\s*)?)(['"])([^'"\n]+)\2/g,
  // export * from './a', export * as ns from './a', export { x } from './a',
  // export type { X } from './a'
  /(\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|{[\s\S]*?})\s+from\s*)(['"])([^'"\n]+)\2/g,
  // import('./a'), including import types in declaration files
  /(\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g,
];

/**
 * Adds explicit file extensions to relative module specifiers, the way Node.js
 * ESM resolution requires: `./a` becomes `./a<extension>` and a directory
 * `./dir` becomes `./dir/index<extension>`.
 *
 * @param {string} code
 * @param {string} filename The file the code belongs to; specifiers are
 *   resolved against its directory.
 * @param {{ extension: string, resolveExtensions: readonly string[] }} options
 *   `extension` is appended to the specifiers, `resolveExtensions` lists the
 *   suffixes that make `./a` or `./dir/index` an existing file.
 * @returns {string}
 */
export function rewriteRelativeSpecifiers(code, filename, options) {
  return SPECIFIER_PATTERNS.reduce(
    (nextCode, pattern) =>
      nextCode.replace(pattern, (match, prefix, quote, value) => {
        const rewritten = rewriteSpecifier(value, filename, options);
        return rewritten && rewritten !== value
          ? `${prefix}${quote}${rewritten}${quote}`
          : match;
      }),
    code
  );
}

function rewriteSpecifier(value, filename, { extension, resolveExtensions }) {
  if (!value || !isRelative(value) || hasQueryOrHash(value)) {
    return null;
  }

  // TypeScript's nodenext resolution requires `.js` specifiers for sibling
  // `.ts` sources; point them at the extension this build emits.
  if (extension !== '.js' && value.endsWith('.js')) {
    const source = path.resolve(path.dirname(filename), value.slice(0, -3));
    if (existsSync(`${source}.ts`) || existsSync(`${source}.tsx`)) {
      return `${value.slice(0, -3)}${extension}`;
    }
  }

  if (KNOWN_EXTS.has(path.extname(value))) {
    return null;
  }

  const resolved = path.resolve(path.dirname(filename), value);
  const toIndex = () => `${value.replace(/\/$/, '')}/index${extension}`;

  try {
    if (resolveExtensions.some((ext) => existsSync(`${resolved}${ext}`))) {
      return `${value}${extension}`;
    }

    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      return toIndex();
    }

    if (
      resolveExtensions.some((ext) =>
        existsSync(path.join(resolved, `index${ext}`))
      )
    ) {
      return toIndex();
    }
  } catch {
    // Keep previous build behavior: fall back to appending the extension.
  }

  return `${value}${extension}`;
}

function isRelative(value) {
  return value.startsWith('./') || value.startsWith('../');
}

function hasQueryOrHash(value) {
  return value.includes('?') || value.includes('#');
}
