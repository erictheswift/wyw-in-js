/**
 * A styled module re-exports a value with `export { … } from` and also uses
 * that value in its own styles. Its importer is transformed first on the same
 * cache, the order bundlers use. While the importer is evaluated, the module
 * is loaded only for the re-exported value, so the eval runner gets a proxy
 * that re-exports it from the source module. The module's own evaluation
 * later in the same session must not reuse that proxy: it does not contain
 * the module's styles, and the module would get no CSS.
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

const palette = "export const base = (() => 'blue')();\n";
const theme = [
  "import { base } from './palette';",
  'export const accent = (() => `${base}-accent`)();',
  '',
].join('\n');

const reexportingModule = (reexport: string) =>
  [
    css,
    "import { accent } from './theme';",
    reexport,
    'export const style = css`background: ${accent};`;',
    '',
  ].join('\n');

const page = (value: string) =>
  [
    css,
    `import { ${value}, style as a } from './A';`,
    `export const className = css\`color: \${${value}}; & .\${a} { color: \${${value}}; }\`;`,
    '',
  ].join('\n');

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
 * Runs the groups one after another on one cache; the files of a group are
 * transformed concurrently. Returns the rule bodies (or the error) of every
 * file.
 */
const transformGroups = async (
  files: Record<string, string>,
  groups: string[][]
): Promise<Record<string, string[] | string>> => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-reexported-value-own-css-'))
  );
  Object.entries(files).forEach(([name, code]) =>
    fs.writeFileSync(path.join(root, name), code)
  );
  const cache = new TransformCacheCollection();
  const asyncResolve = async (what: string, importer: string) =>
    what === 'test-css-processor'
      ? processorFile
      : resolveFile(path.resolve(path.dirname(importer), what));
  const run = async (name: string): Promise<[string, string[] | string]> => {
    try {
      const result = await transform(
        {
          cache,
          options: {
            filename: path.join(root, name),
            root,
            pluginOptions: {
              configFile: false,
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
      return [name, ruleBodies(result.cssText)];
    } catch (error) {
      return [name, `${(error as Error).name}: ${(error as Error).message}`];
    }
  };

  const results: Record<string, string[] | string> = {};
  try {
    for (const group of groups) {
      // eslint-disable-next-line no-await-in-loop
      const settled = await Promise.all(group.map(run));
      settled.forEach(([name, outcome]) => {
        results[name] = outcome;
      });
    }
  } finally {
    disposeEvalBroker(cache);
    fs.rmSync(root, { recursive: true, force: true });
  }

  return results;
};

const project = (reexport: string, value = 'accent') => ({
  'A.ts': reexportingModule(reexport),
  'page.ts': page(value),
  'palette.ts': palette,
  'theme.ts': theme,
});

const expected = {
  'A.ts': ['background:blue-accent;'],
  'page.ts': ['color:blue-accent;', 'color:blue-accent;'],
};

it('extracts the CSS of a module that re-exports a value it uses, after its importer', async () => {
  expect(
    await transformGroups(project("export { accent } from './theme';"), [
      ['page.ts'],
      ['A.ts'],
    ])
  ).toEqual(expected);
});

const variants: [string, Record<string, string>, string[][]][] = [
  [
    'a renamed re-export, importer first',
    project("export { accent as tone } from './theme';", 'tone'),
    [['page.ts'], ['A.ts']],
  ],
  [
    'the importer and the module transformed concurrently',
    project("export { accent } from './theme';"),
    [['page.ts', 'A.ts']],
  ],
  [
    'the module transformed before and after its importer',
    project("export { accent } from './theme';"),
    [['A.ts'], ['page.ts'], ['A.ts']],
  ],
  [
    'a re-export through `export *`, importer first',
    project("export * from './theme';"),
    [['page.ts'], ['A.ts']],
  ],
];

variants.forEach(([title, files, groups]) => {
  it(`extracts the CSS with ${title}`, async () => {
    expect(await transformGroups(files, groups)).toEqual(expected);
  });
});
