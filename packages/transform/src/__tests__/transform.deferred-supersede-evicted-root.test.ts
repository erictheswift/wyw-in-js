/**
 * A module imported while its own root is still being prepared cannot widen
 * that root at once: the importer defers the supersede until the root's
 * preparation finishes. If another transform evicts the root in that window
 * (a freshness walk that finds it stale, or an explicit invalidation) and
 * nothing created the module again yet, the deferred supersede finds no
 * publication. That is an eviction of the root, which the transform owning
 * the root restarts, as at the other publication fences.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import { Entrypoint } from '../transform/Entrypoint';
import { baseHandlers } from '../transform/generators';
import type { AllHandlers } from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';

const processorFile = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const css = "import { css } from 'test-css-processor';";

const pluginOptions = {
  configFile: false,
  babelOptions: { babelrc: false, configFile: false },
  tagResolver: (source: string, tag: string) =>
    source === 'test-css-processor' && tag === 'css' ? processorFile : null,
};

/** Rule bodies of the extracted CSS; class names depend on slugs. */
const ruleBodies = (cssText: string | undefined): string[] =>
  [...(cssText ?? '').matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]);

const files: Record<string, string> = {
  'tokens.ts': "export const colors = { red: 'red' };\n",
  'A.ts': [
    css,
    "import { colors } from './tokens';",
    'export const accent = (() => `${colors.red}-accent`)();',
    'export const style = css`color: ${accent};`;',
    '',
  ].join('\n'),
  'page.ts': [
    css,
    "import { accent } from './A';",
    'export const className = css`background: ${accent};`;',
    '',
  ].join('\n'),
};

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

it('restarts a root evicted before its deferred supersede is applied', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-deferred-evicted-root-'))
  );
  Object.entries(files).forEach(([name, code]) =>
    fs.writeFileSync(path.join(root, name), code)
  );
  const fileA = path.join(root, 'A.ts');
  const cache = new TransformCacheCollection();

  const asyncResolve = async (what: string, importer: string) =>
    what === 'test-css-processor'
      ? processorFile
      : `${path.resolve(path.dirname(importer), what)}.ts`;

  // The root of A.ts is held at the end of its preparation.
  const rootPrepared = createDeferred();
  const releaseRoot = createDeferred();
  let holdRoot = true;
  const rootHandlers = {
    transform: async function* holdPreparedRoot(
      this: { entrypoint: Entrypoint },
      ...args: unknown[]
    ) {
      const result = yield* (
        baseHandlers.transform as (...a: unknown[]) => Generator
      ).apply(this, args);
      if (holdRoot && this.entrypoint.name === fileA) {
        holdRoot = false;
        rootPrepared.resolve();
        await releaseRoot.promise;
      }
      return result;
    },
  } as unknown as Partial<AllHandlers<'sync'>>;

  // page.ts needs `accent` of A.ts while the root is being prepared: it
  // defers the supersede and waits for that preparation.
  const pageWaits = createDeferred();
  const originalWaitForProcessing = Entrypoint.prototype.waitForProcessing;
  const waitForProcessing = jest
    .spyOn(Entrypoint.prototype, 'waitForProcessing')
    .mockImplementation(function waitForRoot(this: Entrypoint) {
      if (this.name === fileA) pageWaits.resolve();
      return originalWaitForProcessing.call(this);
    });

  // The module is evicted after the root got its transform result and before
  // the deferred supersede is applied, as another transform's freshness walk
  // running between those steps would.
  const rootIds = new Set<number>();
  let evictions = 0;
  const rootEmitter = new EventEmitter(
    () => {},
    () => 0,
    (id, _timestamp, event) => {
      if (
        event.type === 'created' &&
        event.filename === fileA &&
        event.parentId === null
      ) {
        rootIds.add(id);
      }
      if (
        event.type === 'setTransformResult' &&
        rootIds.has(id) &&
        evictions === 0
      ) {
        evictions += 1;
        cache.invalidateForFile(fileA);
      }
    },
    false
  );

  const run = (
    name: string,
    eventEmitter?: EventEmitter,
    handlers: Partial<AllHandlers<'sync'>> = {}
  ) =>
    transform(
      {
        cache,
        eventEmitter,
        options: { filename: path.join(root, name), root, pluginOptions },
      },
      files[name],
      asyncResolve,
      handlers
    );

  try {
    const rootTransform = run('A.ts', rootEmitter, rootHandlers);
    rootTransform.catch(() => {});
    await rootPrepared.promise;

    const pageTransform = run('page.ts');
    pageTransform.catch(() => {});
    await pageWaits.promise;

    releaseRoot.resolve();
    const [rootResult, pageResult] = await Promise.all([
      rootTransform,
      pageTransform,
    ]);

    expect(evictions).toBe(1);
    expect(ruleBodies(rootResult.cssText)).toEqual(['color:red-accent;']);
    expect(ruleBodies(pageResult.cssText)).toEqual(['background:red-accent;']);
  } finally {
    waitForProcessing.mockRestore();
    disposeEvalBroker(cache);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
