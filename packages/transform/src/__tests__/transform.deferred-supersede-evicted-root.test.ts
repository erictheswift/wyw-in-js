/**
 * A module imported while its own preparation is still running cannot widen
 * that entrypoint at once: the importer defers the supersede until the
 * preparation finishes. If another transform evicts the module in that window
 * (a freshness walk that finds it stale, or an explicit invalidation) and
 * nothing created the module again yet, the deferred supersede finds no
 * publication. For the root of a transform, that is an eviction of the root,
 * which the transform restarts, as at the other publication fences. For a
 * dependency, the transform still restarts if its own root was published
 * again meanwhile, as after any other aborted dependency.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import { Entrypoint } from '../transform/Entrypoint';
import { isAborted } from '../transform/actions/AbortError';
import { baseHandlers } from '../transform/generators';
import type { AllHandlers, Services } from '../transform/types';
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
  'page2.ts': [
    css,
    "import { accent, style } from './A';",
    'export const className = css`color: ${accent}; & .${style} { margin: 0; }`;',
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

it('restarts a republished root when a dependency is evicted before its deferred supersede', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-deferred-evicted-dependency-'))
  );
  Object.entries(files).forEach(([name, code]) =>
    fs.writeFileSync(path.join(root, name), code)
  );
  const fileA = path.join(root, 'A.ts');
  const filePage = path.join(root, 'page.ts');
  const cache = new TransformCacheCollection();

  const asyncResolve = async (what: string, importer: string) =>
    what === 'test-css-processor'
      ? processorFile
      : `${path.resolve(path.dirname(importer), what)}.ts`;

  // A.ts is held at the end of its preparation as a dependency of page.ts.
  const dependencyPrepared = createDeferred();
  const releaseDependency = createDeferred();
  let holdDependency = true;
  let pageServices: Services | undefined;
  const pageHandlers = {
    transform: async function* holdPreparedDependency(
      this: { entrypoint: Entrypoint; services: Services },
      ...args: unknown[]
    ) {
      const result = yield* (
        baseHandlers.transform as (...a: unknown[]) => Generator
      ).apply(this, args);
      if (holdDependency && this.entrypoint.name === fileA) {
        holdDependency = false;
        pageServices = this.services;
        dependencyPrepared.resolve();
        await releaseDependency.promise;
      }
      return result;
    },
  } as unknown as Partial<AllHandlers<'sync'>>;

  // page2.ts needs more of A.ts while it is being prepared: it defers the
  // supersede and waits for that preparation.
  const page2Waits = createDeferred();
  const originalWaitForProcessing = Entrypoint.prototype.waitForProcessing;
  const waitForProcessing = jest
    .spyOn(Entrypoint.prototype, 'waitForProcessing')
    .mockImplementation(function waitForDependency(this: Entrypoint) {
      if (this.name === fileA) page2Waits.resolve();
      return originalWaitForProcessing.call(this);
    });

  const deferredSupersedeFailures: string[] = [];
  const originalApply = Entrypoint.prototype.applyDeferredSupersede;
  const applyDeferredSupersede = jest
    .spyOn(Entrypoint.prototype, 'applyDeferredSupersede')
    .mockImplementation(function recordFailure(
      this: Entrypoint,
      ...args: Parameters<Entrypoint['applyDeferredSupersede']>
    ) {
      try {
        return originalApply.apply(this, args);
      } catch (error) {
        if (isAborted(error)) {
          deferredSupersedeFailures.push(path.basename(this.name));
        }
        throw error;
      }
    });

  // After the dependency got its transform result, another transform evicts
  // A.ts and, finding page.ts stale too, publishes page.ts again from the
  // unchanged file.
  const dependencyIds = new Set<number>();
  let republished = 0;
  const pageEmitter = new EventEmitter(
    () => {},
    () => 0,
    (id, _timestamp, event) => {
      if (event.type === 'created' && event.filename === fileA) {
        dependencyIds.add(id);
      }
      if (
        event.type === 'setTransformResult' &&
        dependencyIds.has(id) &&
        republished === 0
      ) {
        republished += 1;
        cache.invalidateForFile(fileA);
        cache.invalidateForFile(filePage);
        Entrypoint.createRoot(
          pageServices!,
          filePage,
          ['__wywPreval'],
          undefined
        );
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
    const pageTransform = run('page.ts', pageEmitter, pageHandlers);
    pageTransform.catch(() => {});
    await dependencyPrepared.promise;

    const page2Transform = run('page2.ts');
    page2Transform.catch(() => {});
    await page2Waits.promise;

    releaseDependency.resolve();
    const [pageResult, page2Result] = await Promise.all([
      pageTransform,
      page2Transform,
    ]);

    expect(republished).toBe(1);
    expect(deferredSupersedeFailures).toEqual(['A.ts']);
    expect(ruleBodies(pageResult.cssText)).toEqual(['background:red-accent;']);
    expect(ruleBodies(page2Result.cssText)).toEqual([
      'color:red-accent;',
      'margin:0;',
    ]);
  } finally {
    applyDeferredSupersede.mockRestore();
    waitForProcessing.mockRestore();
    disposeEvalBroker(cache);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
