/**
 * Two transforms share one cache. While a root runs, the other transform
 * finds it stale, evicts it and publishes the same source again for its own
 * import. The root is not superseded, so no successor takes over its
 * workflow; the root must restart on the new publication instead of failing
 * with `AbortError: superseded`. The freshness table runs the same race with
 * two real transforms (`root-and-importer-together-after-dependency-edit`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import { Entrypoint } from '../transform/Entrypoint';
import { baseHandlers } from '../transform/generators';

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

const resolveFile = (candidate: string): string => {
  for (const extension of ['', '.ts']) {
    const file = `${candidate}${extension}`;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  throw new Error(`Cannot resolve ${candidate}`);
};

const asyncResolve = async (what: string, importer: string) =>
  what === 'test-css-processor'
    ? processorFile
    : resolveFile(path.resolve(path.dirname(importer), what));

/** A styled module re-exporting a runtime value of a two-module chain. */
const files: Record<string, string> = {
  'palette.ts': "export const base = (() => 'blue')();\n",
  'theme.ts': [
    "import { base } from './palette';",
    'export const theme = (() => `${base}-theme`)();',
    '',
  ].join('\n'),
  'A.ts': [
    css,
    "import { theme } from './theme';",
    'export { theme };',
    'export const style = css`background: ${theme};`;',
    '',
  ].join('\n'),
  'page.ts': [
    css,
    "import { theme, style as a } from './A';",
    'export const className = css`color: ${theme}; & .${a} { margin: 0; }`;',
    '',
  ].join('\n'),
};

it.each([
  ['a cold root', []],
  ['a root that reused its importer evaluation', ['page.ts']],
])(
  'restarts %s that another transform evicted and published again',
  async (_, before: string[]) => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-republished-root-'))
    );
    Object.entries(files).forEach(([name, code]) =>
      fs.writeFileSync(path.join(root, name), code)
    );
    const cache = new TransformCacheCollection();
    const run = (name: string, handlers = {}) =>
      transform(
        {
          cache,
          options: { filename: path.join(root, name), root, pluginOptions },
        },
        files[name],
        asyncResolve,
        handlers
      );
    const filename = path.join(root, 'A.ts');
    let collects = 0;
    let reusedCopy: boolean | undefined;
    try {
      for (const name of before) {
        // eslint-disable-next-line no-await-in-loop
        await run(name);
      }

      const result = await run('A.ts', {
        collect: function* handler(
          this: { services: Entrypoint['services'] },
          ...args: Parameters<typeof baseHandlers.collect>
        ) {
          collects += 1;
          if (collects === 1) {
            // A root that reused the copy its importer evaluated keeps that
            // copy as its publication.
            reusedCopy = cache.get('entrypoints', filename)?.evaluated === true;
            // Another transform finds the module stale and creates it again
            // from the unchanged file for its own import.
            cache.invalidateForFile(filename);
            Entrypoint.createRoot(
              this.services,
              filename,
              ['__wywPreval'],
              undefined
            );
          }
          return yield* baseHandlers.collect.apply(this as never, args);
        },
      });

      expect(reusedCopy).toBe(before.length > 0);
      expect(ruleBodies(result.cssText)).toEqual(['background:blue-theme;']);
      expect(collects).toBe(2);
    } finally {
      disposeEvalBroker(cache);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
