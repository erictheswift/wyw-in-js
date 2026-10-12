import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import * as esbuild from 'esbuild';

import wywInJS from '../index';

const processorPath = path.resolve(
  __dirname,
  '../../../transform/src/__tests__/__fixtures__/test-css-processor.js'
);

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
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'wyw-esbuild-watch-'))
  );
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writePackage(
    root,
    'test-css-processor',
    "export const css = (strings) => strings.join('');\n"
  );
  writePackage(root, 'tokens', "export const size = (() => '1px')();\n");
  // Options of worker threads (`parallel`) must come from a config file.
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

/** The emitted CSS without whitespace: esbuild reformats it. */
const getCssText = (result: esbuild.BuildResult): string =>
  (
    result.outputFiles
      ?.filter((file) => file.path.endsWith('.css'))
      .map((file) => file.text)
      .join('') ?? ''
  ).replace(/\s/g, '');

/** Records what the wrapped plugin's `onLoad` callbacks return to esbuild. */
const recordOnLoad = (
  plugin: esbuild.Plugin,
  results: Map<string, esbuild.OnLoadResult>
): esbuild.Plugin => ({
  name: plugin.name,
  setup: (build) =>
    plugin.setup({
      ...build,
      onLoad: (options, callback) =>
        build.onLoad(options, async (args) => {
          const result = await callback(args);
          if (result) results.set(args.path, result);
          return result;
        }),
    }),
});

describe('esbuild watch files', () => {
  let cwd: string;
  let root: string;

  beforeEach(() => {
    cwd = process.cwd();
    root = createProject();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  const buildOptions = (plugins: esbuild.Plugin[]): esbuild.BuildOptions => ({
    entryPoints: [path.join(root, 'src', 'index.js')],
    bundle: true,
    format: 'esm',
    write: false,
    outdir: path.join(root, 'dist'),
    plugins,
  });

  it.each([
    { name: 'on the main thread', parallel: undefined },
    { name: 'in worker threads', parallel: 1 },
  ])(
    'returns evaluated dependencies outside node_modules $name',
    async ({ parallel }) => {
      const loads = new Map<string, esbuild.OnLoadResult>();
      const plugin = wywInJS({
        configFile: path.join(root, 'wyw-in-js.config.cjs'),
        parallel,
      });

      const result = await esbuild.build(
        buildOptions([recordOnLoad(plugin, loads)])
      );

      expect(getCssText(result)).toContain('color:blue-light;');
      expect(
        loads.get(path.join(root, 'src', 'index.js'))?.watchFiles?.sort()
      ).toEqual([
        path.join(root, 'src', 'palette.js'),
        path.join(root, 'src', 'theme.js'),
      ]);
    },
    60_000
  );

  it('rebuilds in watch mode when an evaluated dependency changes', async () => {
    const plugin = wywInJS({
      configFile: path.join(root, 'wyw-in-js.config.cjs'),
    });
    let onRebuild: ((css: string) => void) | undefined;
    const nextRebuild = () =>
      new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 10_000);
        onRebuild = (css) => {
          clearTimeout(timer);
          resolve(css);
        };
      });

    const result = await esbuild.build({
      ...buildOptions([plugin]),
      watch: {
        onRebuild: (error, rebuilt) => {
          onRebuild?.(error ? String(error) : getCssText(rebuilt!));
        },
      },
    });

    try {
      expect(getCssText(result)).toContain('color:blue-light;');

      let rebuild = nextRebuild();
      writeFileSync(path.join(root, 'src', 'theme.js'), themeSource('red'));
      expect(await rebuild).toContain('color:red-light;');

      rebuild = nextRebuild();
      writeFileSync(
        path.join(root, 'src', 'palette.js'),
        paletteSource('dark')
      );
      expect(await rebuild).toContain('color:red-dark;');
    } finally {
      result.stop?.();
    }
  }, 60_000);
});
