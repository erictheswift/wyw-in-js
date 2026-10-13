/**
 * A styled module re-exports a value with `export { … } from` and also uses
 * that value in its own styles. Its importer is transformed first on the same
 * cache, the order bundlers use. While the importer is evaluated, the module
 * is loaded for the re-exported value. A proxy that only re-exports the value
 * from its source does not contain the module's styles: the module's own
 * evaluation later in the same session must not reuse one, or the module gets
 * no CSS.
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

const reexportingModule = (reexport: string, property = 'background') =>
  [
    css,
    "import { accent } from './theme';",
    reexport,
    `export const style = css\`${property}: \${accent};\`;`,
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

type Outcome = Record<string, string[] | string>;

/**
 * Runs the steps one after another on one cache. A list of files is
 * transformed concurrently; an object writes files with a later mtime and
 * starts a new build. Returns the rule bodies (or the error) of every file
 * transformed in each build.
 */
const transformSteps = async (
  initialFiles: Record<string, string>,
  steps: (string[] | Record<string, string>)[]
): Promise<Outcome[]> => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-reexported-value-own-css-'))
  );
  const files = { ...initialFiles };
  let mtime = Math.floor(Date.now() / 1000) - 1000;
  const write = (changed: Record<string, string>) => {
    Object.entries(changed).forEach(([name, code]) => {
      const filename = path.join(root, name);
      fs.writeFileSync(filename, code);
      fs.utimesSync(filename, mtime, mtime);
      files[name] = code;
    });
  };
  write(files);

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

  const builds: Outcome[] = [{}];
  try {
    for (const step of steps) {
      if (Array.isArray(step)) {
        // eslint-disable-next-line no-await-in-loop
        const settled = await Promise.all(step.map(run));
        settled.forEach(([name, outcome]) => {
          builds[builds.length - 1][name] = outcome;
        });
      } else {
        mtime += 10;
        write(step);
        builds.push({});
      }
    }
  } finally {
    disposeEvalBroker(cache);
    fs.rmSync(root, { recursive: true, force: true });
  }

  return builds;
};

const transformGroups = async (
  files: Record<string, string>,
  groups: string[][]
): Promise<Outcome> => (await transformSteps(files, groups))[0];

const project = (reexport: string, value = 'accent') => ({
  'A.ts': reexportingModule(reexport),
  'page.ts': page(value),
  'palette.ts': palette,
  'theme.ts': theme,
});

const moduleCss = ['background:blue-accent;'];
const pageCss = ['color:blue-accent;', 'color:blue-accent;'];

const expected = {
  'A.ts': moduleCss,
  'page.ts': pageCss,
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

const reexportedValue = "export { accent } from './theme';";

/** page2.ts reads only the re-exported value. */
const secondImporter = [
  css,
  "import { accent } from './A';",
  'export const other = css`border-color: ${accent};`;',
  '',
].join('\n');

/**
 * Two styled modules in a row re-export the value they use: theme.ts
 * re-exports `base` from palette.ts, A.ts re-exports it from theme.ts.
 */
const reexportingChain = {
  'A.ts': [
    css,
    "import { base } from './theme';",
    "export { base } from './theme';",
    'export const style = css`background: ${base};`;',
    '',
  ].join('\n'),
  'page.ts': page('base'),
  'palette.ts': palette,
  'theme.ts': [
    css,
    "import { base } from './palette';",
    "export { base } from './palette';",
    'export const themeStyle = css`border-color: ${base};`;',
    '',
  ].join('\n'),
};

const shapes: [string, Record<string, string>, string[][], Outcome][] = [
  [
    'a re-export of the default export',
    {
      'A.ts': [
        css,
        "import accent from './theme';",
        "export { default } from './theme';",
        'export const style = css`background: ${accent};`;',
        '',
      ].join('\n'),
      'page.ts': [
        css,
        "import accent, { style as a } from './A';",
        'export const className = css`color: ${accent}; & .${a} { color: ${accent}; }`;',
        '',
      ].join('\n'),
      'palette.ts': palette,
      'theme.ts': [
        "import { base } from './palette';",
        'export default (() => `${base}-accent`)();',
        '',
      ].join('\n'),
    },
    [['page.ts'], ['A.ts']],
    expected,
  ],
  [
    'a chain of two such modules, importer first',
    reexportingChain,
    [['page.ts'], ['theme.ts'], ['A.ts']],
    {
      'A.ts': ['background:blue;'],
      'page.ts': ['color:blue;', 'color:blue;'],
      'theme.ts': ['border-color:blue;'],
    },
  ],
  [
    'a barrel without code of its own in front of the module',
    {
      ...project(reexportedValue),
      'B.ts': "export { accent } from './A';\n",
      'page.ts': [
        css,
        "import { accent } from './B';",
        "import { style as a } from './A';",
        'export const className = css`color: ${accent}; & .${a} { color: ${accent}; }`;',
        '',
      ].join('\n'),
    },
    [['page.ts'], ['A.ts']],
    expected,
  ],
  [
    'an unstyled module between the importer and the module',
    {
      ...project(reexportedValue),
      'helper.ts': [
        "import { accent } from './A';",
        'export const doubled = `${accent}-${accent}`;',
        '',
      ].join('\n'),
      'page.ts': [
        css,
        "import { doubled } from './helper';",
        "import { style as a } from './A';",
        'export const className = css`color: ${doubled}; & .${a} { color: ${doubled}; }`;',
        '',
      ].join('\n'),
    },
    [['page.ts'], ['A.ts']],
    {
      'A.ts': moduleCss,
      'page.ts': [
        'color:blue-accent-blue-accent;',
        'color:blue-accent-blue-accent;',
      ],
    },
  ],
  [
    'two importers transformed first',
    { ...project(reexportedValue), 'page2.ts': secondImporter },
    [['page.ts'], ['page2.ts'], ['A.ts']],
    { ...expected, 'page2.ts': ['border-color:blue-accent;'] },
  ],
  [
    'an importer that also imports the module for its side effects',
    {
      ...project(reexportedValue),
      'page.ts': [
        css,
        "import './A';",
        "import { accent } from './A';",
        'export const className = css`color: ${accent};`;',
        '',
      ].join('\n'),
    },
    [['page.ts'], ['A.ts']],
    { 'A.ts': moduleCss, 'page.ts': ['color:blue-accent;'] },
  ],
];

shapes.forEach(([title, files, groups, outcome]) => {
  it(`extracts the CSS with ${title}`, async () => {
    expect(await transformGroups(files, groups)).toEqual(outcome);
  });
});

it('keeps two importers and the module fresh after edits of the module and of the value source', async () => {
  const build = [['page.ts'], ['page2.ts'], ['A.ts']];
  const builds = await transformSteps(
    { ...project(reexportedValue), 'page2.ts': secondImporter },
    [
      ...build,
      { 'A.ts': reexportingModule(reexportedValue, 'outline-color') },
      ...build,
      { 'theme.ts': theme.replace('-accent', '-tone') },
      ...build,
    ]
  );

  expect(builds).toEqual([
    { ...expected, 'page2.ts': ['border-color:blue-accent;'] },
    {
      'A.ts': ['outline-color:blue-accent;'],
      'page.ts': pageCss,
      'page2.ts': ['border-color:blue-accent;'],
    },
    {
      'A.ts': ['outline-color:blue-tone;'],
      'page.ts': ['color:blue-tone;', 'color:blue-tone;'],
      'page2.ts': ['border-color:blue-tone;'],
    },
  ]);
});
