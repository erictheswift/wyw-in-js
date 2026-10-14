import fs from 'node:fs/promises';
import path from 'node:path';

// The bundler transforms an importer before the styled module it imports. The
// importer evaluates every export of that module, so the module's own
// transform reuses that evaluation; it must still extract its CSS, on the
// cold build and after every edit.

const cssImport = "import { css } from '@wyw-in-js/template-tag-syntax';";

const page = [
  cssImport,
  "import { accent, style as a } from './A';",
  '',
  'export const className = css`color: ${accent}; & .${a} { color: ${accent}; }`;',
  '',
].join('\n');

const pageCss = (accent) => [`color:${accent};`, `color:${accent};`];

const ownValue = (color) =>
  [
    cssImport,
    '',
    `export const accent = (() => '${color}')();`,
    'export const style = css`background: ${accent};`;',
    '',
  ].join('\n');

const palette = (color) => `export const base = (() => '${color}')();\n`;

const reexporting = (property) =>
  [
    cssImport,
    "import { accent } from './theme';",
    '',
    'export { accent };',
    `export const style = css\`${property}: \${accent};\`;`,
    '',
  ].join('\n');

const editedPage = page.replace('color: ${accent};', 'margin: 0;');

const scenarios = [
  {
    name: 'a styled module with its own runtime value',
    files: { 'A.js': ownValue('blue'), 'index.js': page },
    cold: { A: ['background:blue;'], index: pageCss('blue') },
    edits: [
      {
        files: { 'A.js': ownValue('red') },
        css: { A: ['background:red;'], index: pageCss('red') },
      },
      {
        files: { 'A.js': ownValue('green') },
        css: { A: ['background:green;'], index: pageCss('green') },
      },
      {
        files: { 'index.js': editedPage },
        css: {
          A: ['background:green;'],
          index: ['margin:0;', 'color:green;'],
        },
      },
    ],
  },
  {
    name: 'a styled module re-exporting a runtime value',
    files: {
      'palette.js': palette('blue'),
      'theme.js': [
        "import { base } from './palette';",
        '',
        'export const accent = (() => `${base}-accent`)();',
        '',
      ].join('\n'),
      'A.js': reexporting('background'),
      'index.js': page,
    },
    cold: { A: ['background:blue-accent;'], index: pageCss('blue-accent') },
    // Palette edits are not consecutive: from the second edit in a row on,
    // the roots lag one edit behind, a separate staleness of runtime values
    // two modules away (the `transitive-dep-edit` freshness scenario).
    edits: [
      {
        files: { 'palette.js': palette('red') },
        css: { A: ['background:red-accent;'], index: pageCss('red-accent') },
      },
      {
        files: { 'A.js': reexporting('border-color') },
        css: { A: ['border-color:red-accent;'], index: pageCss('red-accent') },
      },
      {
        files: { 'palette.js': palette('green') },
        css: {
          A: ['border-color:green-accent;'],
          index: pageCss('green-accent'),
        },
      },
      {
        files: { 'index.js': editedPage },
        css: {
          A: ['border-color:green-accent;'],
          index: ['margin:0;', 'color:green-accent;'],
        },
      },
      {
        files: { 'palette.js': palette('teal') },
        css: {
          A: ['border-color:teal-accent;'],
          index: ['margin:0;', 'color:teal-accent;'],
        },
      },
    ],
  },
];

/** Rule bodies of every emitted CSS file, keyed by the module name. */
const readRuleBodies = async (outputPath) => {
  const files = (await fs.readdir(outputPath))
    .filter((file) => file.endsWith('.css'))
    .sort();
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => {
        const css = await fs.readFile(path.join(outputPath, file), 'utf8');
        return [
          file.split('.')[0],
          [...css.replace(/\s/g, '').matchAll(/\{([^{}]*)\}/g)].map(
            (match) => match[1]
          ),
        ];
      })
    )
  );
};

/**
 * Runs a scenario in watch mode and checks the CSS of the cold build and of
 * every edit. `scenario.loaders` run before wyw on every module.
 */
export const runWatchScenario = async (
  pkgDir,
  bundler,
  bundlerName,
  scenario
) => {
  const tempDir = await fs.mkdtemp(path.join(pkgDir, 'watch-scenario-'));
  const writeFiles = (files) =>
    Promise.all(
      Object.entries(files).map(([file, content]) =>
        fs.writeFile(path.join(tempDir, file), content)
      )
    );
  await writeFiles(scenario.files);
  const outputPath = path.join(tempDir, 'dist');
  const compiler = bundler({
    mode: 'development',
    context: pkgDir,
    entry: path.join(tempDir, 'index.js'),
    devtool: false,
    output: { path: outputPath, filename: 'bundle.js' },
    cache: true,
    module: {
      rules: [
        {
          test: /\.js$/,
          use: ['@wyw-in-js/webpack-loader', ...(scenario.loaders ?? [])],
        },
        {
          test: /\.wyw-in-js\.css$/,
          type: 'asset/resource',
          generator: { filename: '[name][ext]' },
        },
      ],
    },
  });
  const builds = [];
  let notify;
  const watching = compiler.watch({ aggregateTimeout: 50 }, (error, stats) => {
    builds.push(
      error ??
        (stats.hasErrors()
          ? new Error(stats.toString({ all: false, errors: true }))
          : null)
    );
    notify?.();
  });
  const waitForBuild = (index) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        notify = undefined;
        reject(new Error(`${bundlerName} watch rebuild timed out`));
      }, 30000);
      notify = () => {
        if (builds.length <= index) {
          return;
        }
        clearTimeout(timer);
        notify = undefined;
        const error = builds[index];
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      notify();
    });
  const assertCss = async (step, expected) => {
    const actual = JSON.stringify(await readRuleBodies(outputPath));
    if (actual !== JSON.stringify(expected)) {
      const where = `${bundlerName} watch (${scenario.name}), ${step}`;
      throw new Error(
        `${where}: expected ${JSON.stringify(expected)}, emitted ${actual}`
      );
    }
  };
  try {
    await waitForBuild(0);
    await assertCss('cold build', scenario.cold);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (const [index, edit] of scenario.edits.entries()) {
      const pending = waitForBuild(builds.length);
      await writeFiles(edit.files);
      await pending;
      await assertCss(`edit ${index + 1}`, edit.css);
    }
  } finally {
    await new Promise((resolve, reject) =>
      watching.close((error) => (error ? reject(error) : resolve()))
    );
    await new Promise((resolve, reject) =>
      compiler.close((error) => (error ? reject(error) : resolve()))
    );
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

export async function assertWatchImporterFirst(pkgDir, bundler, bundlerName) {
  for (const scenario of scenarios) {
    await runWatchScenario(pkgDir, bundler, bundlerName, scenario);
  }
}
