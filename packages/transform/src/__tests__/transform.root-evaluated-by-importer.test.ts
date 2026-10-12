/**
 * A styled module is transformed as a root after another root (its importer)
 * has evaluated every value export of it through the same cache, the order
 * webpack and Vite use. The importer publishes an evaluated copy of the module
 * that covers all of its exports, so the module's own root reuses that copy
 * instead of being prepared again. Its evaluation must accept the copy as its
 * own publication rather than reject it as superseded.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';

const processorFile = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const css = "import { css } from 'test-css-processor';";

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

/**
 * Transforms `order` one by one on one cache and returns the rule bodies of
 * every call (or its error message) in call order.
 */
const transformInOrder = async (
  files: Record<string, string>,
  order: string[]
): Promise<[string, string[] | string][]> => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-root-evaluated-by-importer-'))
  );
  Object.entries(files).forEach(([name, code]) =>
    fs.writeFileSync(path.join(root, name), code)
  );
  const cache = new TransformCacheCollection();
  const asyncResolve = async (what: string, importer: string) =>
    what === 'test-css-processor'
      ? processorFile
      : resolveFile(path.resolve(path.dirname(importer), what));

  const results: [string, string[] | string][] = [];
  try {
    for (const name of order) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await transform(
          {
            cache,
            options: {
              filename: path.join(root, name),
              root,
              pluginOptions: {
                configFile: false,
                babelOptions: { babelrc: false, configFile: false },
                tagResolver: (source: string, tag: string) =>
                  source === 'test-css-processor' && tag === 'css'
                    ? processorFile
                    : null,
              },
            },
          },
          files[name],
          asyncResolve
        );
        results.push([name, ruleBodies(result.cssText)]);
      } catch (error) {
        results.push([
          name,
          `${(error as Error).name}: ${(error as Error).message}`,
        ]);
      }
    }
  } finally {
    disposeEvalBroker(cache);
    fs.rmSync(root, { recursive: true, force: true });
  }

  return results;
};

/** A styled module with a value that only the eval runner can compute. */
const styledWithRuntimeValue = [
  css,
  "export const accent = (() => 'inline-accent')();",
  'export const style = css`background: white;`;',
  '',
].join('\n');

const pageReadingAll = [
  css,
  "import { accent, style as a } from './A';",
  'export const className = css`color: ${accent}; & .${a} { color: ${accent}; }`;',
  '',
].join('\n');

it('transforms a styled module after its importer evaluated all of its exports', async () => {
  expect(
    await transformInOrder(
      { 'A.ts': styledWithRuntimeValue, 'page.ts': pageReadingAll },
      ['page.ts', 'A.ts', 'A.ts']
    )
  ).toEqual([
    ['page.ts', ['color:inline-accent;', 'color:inline-accent;']],
    ['A.ts', ['background:white;']],
    ['A.ts', ['background:white;']],
  ]);
});

interface Shape {
  files: Record<string, string>;
  order: string[];
  css: Record<string, string[]>;
}

const shapes: Record<string, Shape> = {
  'an object of classes with a computed member': {
    files: {
      'A.ts': [
        css,
        'const Base = css`color: red;`;',
        "export const Styles = { Base, size: (() => '4px')() };",
        '',
      ].join('\n'),
      'page.ts': [
        css,
        "import { Styles } from './A';",
        'export const className = css`margin: ${Styles.size}; & .${Styles.Base} { color: blue; }`;',
        '',
      ].join('\n'),
    },
    order: ['page.ts', 'A.ts'],
    css: {
      'page.ts': ['margin:4px;', 'color:blue;'],
      'A.ts': ['color:red;'],
    },
  },
  'a tokens object with a computed property': {
    files: {
      'A.ts': [
        css,
        "export const tokens = { accent: ['token', 'accent'].join('-') };",
        'export const style = css`background: white;`;',
        '',
      ].join('\n'),
      'page.ts': [
        css,
        "import { tokens, style } from './A';",
        'export const className = css`color: ${tokens.accent}; & .${style} { margin: 0; }`;',
        '',
      ].join('\n'),
    },
    order: ['page.ts', 'A.ts'],
    css: {
      'page.ts': ['color:token-accent;', 'margin:0;'],
      'A.ts': ['background:white;'],
    },
  },
  'an object of classes next to a computed export': {
    files: {
      'A.ts': [
        css,
        'export const Styles = { Base: css`color: red;` };',
        "export const size = (() => '4px')();",
        '',
      ].join('\n'),
      'page.ts': [
        css,
        "import { Styles, size } from './A';",
        'export const className = css`margin: ${size}; & .${Styles.Base} { color: blue; }`;',
        '',
      ].join('\n'),
    },
    order: ['page.ts', 'A.ts'],
    css: {
      'page.ts': ['margin:4px;', 'color:blue;'],
      'A.ts': ['color:red;'],
    },
  },
  'a default-exported class next to a computed value': {
    files: {
      'A.ts': [
        css,
        "export const accent = (() => 'inline-accent')();",
        'export default css`background: white;`;',
        '',
      ].join('\n'),
      'page.ts': [
        css,
        "import a, { accent } from './A';",
        'export const className = css`color: ${accent}; & .${a} { color: red; }`;',
        '',
      ].join('\n'),
    },
    order: ['page.ts', 'A.ts'],
    css: {
      'page.ts': ['color:inline-accent;', 'color:red;'],
      'A.ts': ['background:white;'],
    },
  },
  'a namespace import that reads every member': {
    files: {
      'A.ts': styledWithRuntimeValue,
      'page.ts': [
        css,
        "import * as A from './A';",
        'export const className = css`color: ${A.accent}; & .${A.style} { color: red; }`;',
        '',
      ].join('\n'),
    },
    order: ['page.ts', 'A.ts'],
    css: {
      'page.ts': ['color:inline-accent;', 'color:red;'],
      'A.ts': ['background:white;'],
    },
  },
  'a type export next to the value exports': {
    files: {
      'A.ts': [
        css,
        "export type Size = 's' | 'm';",
        "export const accent = (() => 'inline-accent')();",
        'export const style = css`background: white;`;',
        '',
      ].join('\n'),
      'page.ts': pageReadingAll,
    },
    order: ['page.ts', 'A.ts'],
    css: {
      'page.ts': ['color:inline-accent;', 'color:inline-accent;'],
      'A.ts': ['background:white;'],
    },
  },
  'two importers before the module': {
    files: {
      'A.ts': styledWithRuntimeValue,
      'page.ts': pageReadingAll,
      'page2.ts': [
        css,
        "import { accent, style as a } from './A';",
        'export const other = css`border-color: ${accent}; & .${a} { margin: 0; }`;',
        '',
      ].join('\n'),
    },
    order: ['page.ts', 'page2.ts', 'A.ts'],
    css: {
      'page.ts': ['color:inline-accent;', 'color:inline-accent;'],
      'page2.ts': ['border-color:inline-accent;', 'margin:0;'],
      'A.ts': ['background:white;'],
    },
  },
  'a chain C -> B -> A transformed from the top': {
    files: {
      'A.ts': styledWithRuntimeValue,
      'B.ts': [
        css,
        "import { accent, style as a } from './A';",
        'export const b = (() => `${accent}-b`)();',
        'export const styleB = css`color: ${accent}; & .${a} { color: red; }`;',
        '',
      ].join('\n'),
      'C.ts': [
        css,
        "import { b, styleB } from './B';",
        'export const className = css`color: ${b}; & .${styleB} { color: red; }`;',
        '',
      ].join('\n'),
    },
    order: ['C.ts', 'B.ts', 'A.ts'],
    css: {
      'C.ts': ['color:inline-accent-b;', 'color:red;'],
      'B.ts': ['color:inline-accent;', 'color:red;'],
      'A.ts': ['background:white;'],
    },
  },
};

it.each(Object.entries(shapes))(
  'transforms the module after its importers: %s',
  async (_, shape) => {
    expect(await transformInOrder(shape.files, shape.order)).toEqual(
      shape.order.map((name) => [name, shape.css[name]])
    );
  }
);
