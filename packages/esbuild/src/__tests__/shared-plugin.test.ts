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

const tagResolver = (source: string, tag: string) =>
  source === 'test-css-processor' && tag === 'css' ? processorPath : null;

const styledSource = (importLine: string) =>
  [
    "import { css } from 'test-css-processor';",
    importLine,
    '',
    'export const className = css`color: ${color};`;',
    '',
  ].join('\n');

const createProject = (): string => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'wyw-esbuild-shared-'))
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

  // Not a module the plugin transforms: that build never waits for the
  // other one through a shared cache.
  writeFileSync(path.join(root, 'src', 'plain.css'), 'a { color: red; }\n');
  writeFileSync(
    path.join(root, 'src', 'styled.js'),
    styledSource("import { color } from './slow';")
  );
  writeFileSync(
    path.join(root, 'src', 'slow.js'),
    "export const color = (() => 'green')();\n"
  );
  writeFileSync(
    path.join(root, 'src', 'theme.js'),
    "export const color = (() => 'blue')();\n"
  );
  writeFileSync(
    path.join(root, 'src', 'themed.js'),
    styledSource("import { color } from './theme';")
  );

  return root;
};

// Bounds every wait of the test, so a deadlock fails the test instead of
// hanging it.
const orTimeout = (promise: Promise<void>) =>
  Promise.race([
    promise,
    new Promise<void>((resolve) => {
      setTimeout(resolve, 5_000);
    }),
  ]);

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

const getCssText = (result: esbuild.BuildResult): string =>
  (
    result.outputFiles
      ?.filter((file) => file.path.endsWith('.css'))
      .map((file) => file.text)
      .join('') ?? ''
  ).replace(/\s/g, '');

describe('esbuild plugin instance shared by builds', () => {
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

  const buildOptions = (
    entry: string,
    plugins: esbuild.Plugin[]
  ): esbuild.BuildOptions => ({
    entryPoints: [path.join(root, 'src', entry)],
    bundle: true,
    format: 'esm',
    write: false,
    outdir: path.join(root, 'dist', entry),
    plugins,
  });

  it('lets a build finish while another one is evaluating', async () => {
    const slowRequested = deferred();
    const slowReleased = deferred();
    const plugin = wywInJS({
      configFile: false,
      eval: {
        // The eval runner asks for module code while it evaluates a root:
        // hold ./slow until the plain build has ended.
        customLoader: async (id) => {
          if (id === path.join(root, 'src', 'slow.js')) {
            slowRequested.resolve();
            await orTimeout(slowReleased.promise);
          }

          return null;
        },
      },
      tagResolver,
    });
    // Ends the plain build only once the styled one is inside an evaluation.
    const waitForEvaluation: esbuild.Plugin = {
      name: 'wait-for-evaluation',
      setup(build) {
        build.onEnd(() => orTimeout(slowRequested.promise));
      },
    };

    const styled = esbuild.build(buildOptions('styled.js', [plugin]));
    const plain = await esbuild.build(
      buildOptions('plain.css', [waitForEvaluation, plugin])
    );
    slowReleased.resolve();

    expect(plain.errors).toEqual([]);
    expect(getCssText(await styled)).toContain('color:green;');
  }, 60_000);

  it('keeps prepared modules across rebuilds of one build', async () => {
    const resolved: string[] = [];
    const plugin = wywInJS({
      configFile: false,
      eval: {
        customResolver: async (specifier) => {
          resolved.push(specifier);
          return null;
        },
      },
      tagResolver,
    });

    const result = (await esbuild.build({
      ...buildOptions('themed.js', [plugin]),
      incremental: true,
    })) as esbuild.BuildIncremental;

    try {
      expect(getCssText(result)).toContain('color:blue;');
      expect(resolved).toContain('./theme');

      // The first build prepares modules from scratch. A rebuild reuses them,
      // so the custom resolver is asked less (only by the evaluation).
      const coldResolved = resolved.splice(0);
      const rebuilt = await result.rebuild();

      expect(getCssText(rebuilt)).toContain('color:blue;');
      expect(resolved.length).toBeLessThan(coldResolved.length);
    } finally {
      result.rebuild.dispose();
    }
  }, 60_000);
});
