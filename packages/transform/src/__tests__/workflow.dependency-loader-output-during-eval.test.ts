/**
 * #422, from the reporter's test. A loader that runs before wyw (Storybook's
 * react-docgen-loader) appends a statement to modules exporting plain
 * components, so the code the `image` root is created with differs from the
 * bytes other roots read from disk. No file changes during the test.
 *
 * `bg` is a root that imports `image`. While `bg` waits for evaluation, the
 * `image` root arrives with its loader output and `hero` runs again. Reporting
 * that difference as a change of `image` used to evict every importer
 * walked afterwards: the in-flight `bg` root was evicted and created again
 * as `hero`'s dependency, and its evaluation failed with
 * `AbortError: superseded` (later the root restarted instead). The disk
 * bytes still match what the importers read, so only `image` itself is
 * replaced and `bg` finishes on its first attempt.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import { EventEmitter } from '../utils/EventEmitter';

const processorFile = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
};

const resolveWithExtensions = (candidate: string) => {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const withExt = `${candidate}${ext}`;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }

  return null;
};

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

const waitFor = (predicate: () => boolean, attempts = 200): Promise<void> =>
  predicate() || attempts === 0
    ? Promise.resolve()
    : tick().then(() => waitFor(predicate, attempts - 1));

type EvalFileGate = <TRes>(fn: () => TRes) => TRes;

class EvalFileGateEmitter extends EventEmitter {
  public evaluations = 0;

  constructor(private readonly gate: EvalFileGate) {
    super(
      () => {},
      () => 0,
      () => {},
      false
    );
  }

  public perf<TRes>(method: string, fn: () => TRes): TRes {
    if (method === 'transform:evalFile') {
      this.evaluations += 1;
      return this.gate(fn);
    }

    return super.perf(method, fn);
  }
}

const passThrough: EvalFileGate = (fn) => fn();

it('keeps a root waiting for eval when its dependency arrives with loader output', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'wyw-dependency-loader-output-')
  );
  const tokensFile = path.join(root, 'tokens.ts');
  const imageFile = path.join(root, 'image.ts');
  const imageUserFile = path.join(root, 'image-user.ts');
  const bgFile = path.join(root, 'bg.ts');
  const heroFile = path.join(root, 'hero.ts');

  const imageCode = dedent`
    import { css } from 'test-css-processor';
    import { colors } from './tokens';

    const px = (n: number) => n + 'px';

    export const IMAGE_ERROR = 'img-error';
    export const imageSize = px(16);
    export const Image = () => null;
    export const image = css\`
      color: \${colors.blue};
    \`;
  `;

  const imageUserCode = dedent`
    import { css } from 'test-css-processor';
    import { imageSize } from './image';

    export const icon = css\`
      width: \${imageSize};
    \`;
  `;

  // `gradient` is not statically evaluable, so `bg` and its consumers
  // evaluate `bg`.
  const bgCode = dedent`
    import { css } from 'test-css-processor';
    import { colors } from './tokens';
    import { IMAGE_ERROR, Image } from './image';

    const mix = (color: string) => color + '-mixed';

    export const gradient = mix(colors.red);
    export const BackgroundImage = () => Image();
    export const fallback = css\`
      background: \${gradient};
      & .\${IMAGE_ERROR} { color: \${colors.blue}; }
    \`;
  `;

  const heroCode = dedent`
    import { css } from 'test-css-processor';
    import { gradient } from './bg';

    export const hero = css\`
      background: \${gradient};
    \`;
  `;

  const imageLoadedCode = `${imageCode}\nImage.__docgenInfo = { displayName: 'Image' };\n`;

  fs.writeFileSync(
    tokensFile,
    `export const colors = { red: 'red', blue: 'blue' };`
  );
  fs.writeFileSync(imageFile, imageCode);
  fs.writeFileSync(imageUserFile, imageUserCode);
  fs.writeFileSync(bgFile, bgCode);
  fs.writeFileSync(heroFile, heroCode);

  const cache = new TransformCacheCollection();
  const evictions = jest.spyOn(cache, 'invalidateForFile');

  const asyncResolve = async (what: string, importer: string) => {
    if (what === 'test-css-processor') {
      return processorFile;
    }

    const resolved = resolveWithExtensions(
      path.resolve(path.dirname(importer), what)
    );
    if (!resolved) {
      throw new Error(
        `Unexpected resolve ${JSON.stringify(what)} from ${importer}`
      );
    }

    return resolved;
  };

  const run = (
    filename: string,
    code: string,
    eventEmitter = new EvalFileGateEmitter(passThrough)
  ) =>
    transform(
      {
        cache,
        eventEmitter,
        options: {
          filename,
          root,
          pluginOptions: {
            configFile: false,
            tagResolver: (source, tag) =>
              source === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
            babelOptions: {
              babelrc: false,
              configFile: false,
              presets: [
                ['@babel/preset-env', { loose: true }],
                '@babel/preset-typescript',
              ],
            },
          },
        },
      },
      code,
      asyncResolve
    );

  try {
    // Consumers read `bg` and `image` from disk.
    await run(heroFile, heroCode);
    await run(imageUserFile, imageUserCode);
    evictions.mockClear();

    // The `bg` root is held before evaluation.
    const bgReachedEval = createDeferred();
    const releaseBg = createDeferred();
    const bgEmitter = new EvalFileGateEmitter((fn) => {
      bgReachedEval.resolve();
      return releaseBg.promise.then(fn) as ReturnType<typeof fn>;
    });
    const bgTransform = run(bgFile, bgCode, bgEmitter);
    bgTransform.catch(() => {});
    await bgReachedEval.promise;
    const bgRoot = cache.get('entrypoints', bgFile);

    // The `image` root is created from its loaded code.
    await run(imageFile, imageLoadedCode);

    // The consumer runs again. It needs `bg`'s exports, so it is not awaited
    // before `bg` is released.
    let heroSettled = false;
    const heroTransform = run(heroFile, heroCode);
    heroTransform.then(
      () => {
        heroSettled = true;
      },
      () => {
        heroSettled = true;
      }
    );
    await waitFor(() => {
      const current = cache.get('entrypoints', bgFile);
      return heroSettled || (current !== undefined && current !== bgRoot);
    });

    releaseBg.resolve();
    const [bgResult, heroResult] = await Promise.all([
      bgTransform,
      heroTransform,
    ]);

    expect(bgResult.cssText).toContain('background:red-mixed');
    expect(heroResult.cssText).toContain('background:red-mixed');
    // Only `image` is replaced; its importers keep their cache entries.
    expect(
      evictions.mock.calls.map(([filename]) => path.basename(filename))
    ).toEqual(['image.ts']);
    // The `bg` root reached evaluation once: it was neither evicted nor
    // restarted.
    expect(bgEmitter.evaluations).toBe(1);
  } finally {
    evictions.mockRestore();
    disposeEvalBroker(cache);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
