#!/usr/bin/env node

// Checks the declaration files that the published packages ship the way a
// consumer with `skipLibCheck: false` sees them, under each module resolution
// mode: every file must type-check, so every relative and package import must
// resolve, and each package name must resolve to the `types` of its `exports`.
// Run after `bun run build`.
//
// Usage: node scripts/check-published-types.mjs [workspace root]

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { argv, cwd, exit } from 'node:process';

import { globSync } from 'glob';
import ts from 'typescript';

const MODES = [
  {
    name: 'node16',
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    selfReference: true,
  },
  {
    name: 'nodenext',
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    selfReference: true,
  },
  {
    name: 'bundler',
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    selfReference: true,
  },
  {
    name: 'node10',
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    // Node10 resolution ignores `exports`, so a package cannot import itself.
    selfReference: false,
  },
];

// Modules that come from the environment of a package rather than from its
// files: `bun-types`, a dependency of @wyw-in-js/bun, declares `bun` globally.
// Loading it here would pull in a second copy of @types/node.
const AMBIENT_MODULES = new Set(['bun']);

const root = path.resolve(cwd(), argv[2] ?? '.');
const packages = readPublishedPackages(root);

if (packages.length === 0) {
  console.error(`No published packages with exported types under ${root}`);
  exit(1);
}

const declarationFiles = packages.flatMap((pkg) => pkg.declarationFiles);
const problems = MODES.flatMap((mode) => checkMode(mode));

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(
    `\n${problems.length} problem(s) in the published declaration files.`
  );
  exit(1);
}

console.log(
  `Checked ${declarationFiles.length} declaration files of ${
    packages.length
  } packages under ${MODES.map((mode) => mode.name).join(', ')}.`
);

function readPublishedPackages(workspaceRoot) {
  return globSync('packages/*/package.json', {
    absolute: true,
    cwd: workspaceRoot,
  })
    .sort()
    .map((packageJsonPath) => {
      const dir = path.dirname(packageJsonPath);
      const json = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      const types = json.exports?.['.']?.types;
      return { dir, json, types };
    })
    .filter(({ json, types }) => !json.private && typeof types === 'string')
    .map(({ dir, json, types }) => ({
      declarationFiles: globSync('types/**/*.d.ts', {
        absolute: true,
        cwd: dir,
        nodir: true,
      }).sort(),
      dir,
      name: json.name,
      typesEntry: path.resolve(dir, types),
    }));
}

function checkMode(mode) {
  const options = {
    esModuleInterop: true,
    module: mode.module,
    moduleResolution: mode.moduleResolution,
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    types: [],
  };
  const program = ts.createProgram(declarationFiles, options);
  const problems = [];

  ts.getPreEmitDiagnostics(program).forEach((diagnostic) => {
    const { file } = diagnostic;
    if (!file || !isPublishedFile(file.fileName)) {
      return;
    }

    if (diagnostic.code === 2307 && isAmbientModuleError(diagnostic)) {
      return;
    }

    const { line, character } = file.getLineAndCharacterOfPosition(
      diagnostic.start ?? 0
    );
    problems.push(
      `[${mode.name}] ${path.relative(root, file.fileName)}:${line + 1}:${
        character + 1
      } TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        ' '
      )}`
    );
  });

  if (mode.selfReference) {
    packages.forEach((pkg) => {
      const { resolvedModule } = ts.resolveModuleName(
        pkg.name,
        path.join(pkg.dir, '__consumer__.mts'),
        options,
        ts.sys,
        undefined,
        undefined,
        ts.ModuleKind.ESNext
      );
      const resolved = resolvedModule?.resolvedFileName;
      if (!resolved || path.resolve(resolved) !== pkg.typesEntry) {
        problems.push(
          `[${mode.name}] ${pkg.name} resolves to ${
            resolved ? path.relative(root, resolved) : 'nothing'
          } instead of ${path.relative(root, pkg.typesEntry)}`
        );
      }
    });
  }

  return problems;
}

function isPublishedFile(fileName) {
  const resolved = path.resolve(fileName);
  return packages.some((pkg) =>
    resolved.startsWith(`${path.join(pkg.dir, 'types')}${path.sep}`)
  );
}

function isAmbientModuleError(diagnostic) {
  const specifier = diagnostic.file.text.slice(
    diagnostic.start,
    diagnostic.start + diagnostic.length
  );
  return AMBIENT_MODULES.has(specifier.replace(/^['"]|['"]$/g, ''));
}
