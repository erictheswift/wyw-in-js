import { spawnSync } from 'child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const rollupWatchPath = path.resolve(
  __dirname,
  '__fixtures__',
  'rollup-watch.ts'
);
const processorPath = path.resolve(
  __dirname,
  '../../../transform/src/__tests__/__fixtures__/test-css-processor.js'
);

type WatchReport = {
  builds: { css: string[]; transformDependencies: string[] }[];
  timedOut: boolean;
};

const themeSource = (color: string) =>
  [
    "import { tone } from './palette';",
    '',
    `export const color = (() => '${color}-' + tone)();`,
    '',
  ].join('\n');

const paletteSource = (tone: string) =>
  `export const tone = (() => '${tone}')();\n`;

const writePackage = (root: string, name: string, source: string) => {
  const dir = path.join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, main: 'index.js', type: 'module' })
  );
  writeFileSync(path.join(dir, 'index.js'), source);
};

/**
 * src/index.js reads `color` from ./theme (which reads ./palette) and `size`
 * from the `tokens` package. All three values need the eval runner, and the
 * imports are gone from the transformed code.
 */
const createProject = (): string => {
  // `process.cwd()` is a real path after chdir (e.g. /private/var on macOS).
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'wyw-rollup-watch-'))
  );
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writePackage(
    root,
    'test-css-processor',
    "export const css = (strings) => strings.join('');\n"
  );
  writePackage(root, 'tokens', "export const size = (() => '1px')();\n");
  writeFileSync(
    path.join(root, 'wyw-in-js.config.cjs'),
    [
      'module.exports = {',
      "  importOverrides: { tokens: { unknown: 'allow' } },",
      '  tagResolver(source, tag) {',
      `    if (source === 'test-css-processor' && tag === 'css') return ${JSON.stringify(
        processorPath
      )};`,
      '    return null;',
      '  },',
      '};',
      '',
    ].join('\n')
  );
  writeFileSync(
    path.join(root, 'src', 'index.js'),
    [
      "import { css } from 'test-css-processor';",
      "import { size } from 'tokens';",
      "import { color } from './theme';",
      '',
      'export const className = css`',
      '  color: ${color};',
      '  border-width: ${size};',
      '`;',
      '',
    ].join('\n')
  );
  writeFileSync(path.join(root, 'src', 'theme.js'), themeSource('blue'));
  writeFileSync(path.join(root, 'src', 'palette.js'), paletteSource('light'));

  return root;
};

const runWatch = (
  root: string,
  edits: { content: string; file: string }[]
): WatchReport => {
  const result = spawnSync(
    process.execPath,
    [rollupWatchPath, JSON.stringify(edits)],
    { cwd: root, encoding: 'utf8', timeout: 60_000 }
  );

  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);

  return JSON.parse(result.stdout);
};

describe('rollup watch', () => {
  let root: string;

  beforeEach(() => {
    root = createProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('watches evaluated dependencies outside node_modules', () => {
    const { builds } = runWatch(root, []);

    expect(builds).toHaveLength(1);
    expect(builds[0].css.join('')).toContain('color:blue-light;');
    expect(builds[0].transformDependencies.sort()).toEqual([
      path.join(root, 'src', 'palette.js'),
      path.join(root, 'src', 'theme.js'),
    ]);
  }, 60_000);

  it('re-transforms the importer when an evaluated dependency changes', () => {
    const report = runWatch(root, [
      { file: 'src/theme.js', content: themeSource('red') },
      { file: 'src/palette.js', content: paletteSource('dark') },
    ]);

    expect(report.timedOut).toBe(false);
    expect(report.builds.map(({ css }) => css.join(''))).toEqual([
      expect.stringContaining('color:blue-light;'),
      expect.stringContaining('color:red-light;'),
      expect.stringContaining('color:red-dark;'),
    ]);
  }, 60_000);
});
