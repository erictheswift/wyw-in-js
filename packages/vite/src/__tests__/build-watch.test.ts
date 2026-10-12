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

const viteBuildWatchPath = path.resolve(
  __dirname,
  '__fixtures__',
  'vite-build-watch.ts'
);
const processorPath = path.resolve(
  __dirname,
  '../../../transform/src/__tests__/__fixtures__/test-css-processor.js'
);

type WatchReport = { builds: string[]; timedOut: boolean };

const themeSource = (color: string) =>
  [
    "import { tone } from './palette';",
    '',
    `export const color = (() => '${color}-' + tone)();`,
    '',
  ].join('\n');

const paletteSource = (tone: string) =>
  `export const tone = (() => '${tone}')();\n`;

/**
 * src/index.js reads `color` from ./theme, which reads ./palette. Both values
 * need the eval runner, and the import is gone from the transformed code.
 */
const createProject = (): string => {
  // `process.cwd()` is a real path after chdir (e.g. /private/var on macOS).
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'wyw-vite-build-watch-'))
  );
  const processorDir = path.join(root, 'node_modules', 'test-css-processor');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(processorDir, { recursive: true });
  writeFileSync(
    path.join(processorDir, 'package.json'),
    JSON.stringify({ name: 'test-css-processor', main: 'index.js' })
  );
  writeFileSync(
    path.join(processorDir, 'index.js'),
    "export const css = (strings) => strings.join('');\n"
  );
  writeFileSync(
    path.join(root, 'wyw-in-js.config.cjs'),
    [
      'module.exports = {',
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
      "import { color } from './theme';",
      '',
      'export const className = css`color: ${color};`;',
      '',
    ].join('\n')
  );
  writeFileSync(path.join(root, 'src', 'theme.js'), themeSource('blue'));
  writeFileSync(path.join(root, 'src', 'palette.js'), paletteSource('light'));

  return root;
};

const runBuildWatch = (
  root: string,
  edits: { content: string; file: string }[],
  options: Record<string, unknown>
): WatchReport => {
  const result = spawnSync(
    process.execPath,
    [viteBuildWatchPath, JSON.stringify(edits), JSON.stringify(options)],
    { cwd: root, encoding: 'utf8', timeout: 60_000 }
  );

  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);

  return JSON.parse(result.stdout);
};

describe('vite build --watch', () => {
  let root: string;

  beforeEach(() => {
    root = createProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { name: 'on the main thread', options: {} },
    { name: 'in worker threads', options: { parallel: 1 } },
  ])(
    're-transforms the importer when an evaluated dependency changes $name',
    ({ options }) => {
      const report = runBuildWatch(
        root,
        [
          { file: 'src/theme.js', content: themeSource('red') },
          { file: 'src/palette.js', content: paletteSource('dark') },
        ],
        options
      );

      expect(report.timedOut).toBe(false);
      expect(report.builds).toEqual([
        expect.stringContaining('color:blue-light;'),
        expect.stringContaining('color:red-light;'),
        expect.stringContaining('color:red-dark;'),
      ]);
    },
    60_000
  );
});
