import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import type { PluginOptions } from '../types';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const createResolver = () => async (what: string, importer: string) => {
  if (what === 'test-css-processor') {
    return processorFile;
  }
  if (what.startsWith('.')) {
    const base = resolve(dirname(importer), what);
    for (const ext of ['', '.ts', '.tsx', '.js']) {
      if (existsSync(base + ext)) {
        return base + ext;
      }
    }
    return base;
  }
  return null;
};

const runStatic = async (
  source: string,
  modules: Record<string, string> = {}
) => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-cross-binding-'));
  const entryFile = join(root, 'entry.tsx');
  writeFileSync(entryFile, source);
  Object.entries(modules).forEach(([name, code]) => {
    writeFileSync(join(root, name), code);
  });

  try {
    return await transform(
      {
        cache: new TransformCacheCollection(),
        options: {
          filename: entryFile,
          root,
          pluginOptions: {
            configFile: false,
            eval: { require: 'off', strategy: 'static', resolver: 'native' },
            tagResolver: (tagSource: string, tag: string) =>
              tagSource === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
          } as Partial<PluginOptions> as PluginOptions,
        },
      },
      readFileSync(entryFile, 'utf8'),
      createResolver()
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const HEADER = "import { css } from 'test-css-processor';";

const tokensModule = dedent`
  export const space = {s12: 12, s16: 16};
  export const fontSize = {xs: 11, sm: 13};
`;

const TAG = 'export const a = css`padding: ${space.s12}px;`;';

/**
 * An opaque module-level call consuming one imported binding must not poison
 * sibling bindings the call never receives. A story file that derives a
 * lookup table from `fontSize` must still resolve `space.s12` statically.
 */
describe('opaque call consuming one binding does not poison siblings', () => {
  const expectResolved = (cssText: string) => {
    expect(cssText).toContain('padding:12px');
  };

  it.each([
    ['a builtin whole-object read', 'const names = Object.keys(fontSize);'],
    [
      'a builtin entries read with a map callback',
      'const byValue = Object.fromEntries(Object.entries(fontSize).map(([k, v]) => [v, k]));',
    ],
    ['a coercion of the sibling', 'export const label = String(fontSize);'],
  ])('resolves when the sibling is consumed by %s', async (_description, call) => {
    const result = await runStatic(
      [
        HEADER,
        "import { fontSize, space } from './tokens';",
        '',
        call,
        TAG,
      ].join('\n'),
      { 'tokens.ts': tokensModule }
    );
    expectResolved(result.cssText);
  });

  it('resolves when the sibling-consuming call carries a PURE annotation', async () => {
    const result = await runStatic(
      [
        HEADER,
        "import { fontSize, space } from './tokens';",
        '',
        'const names = /*#__PURE__*/ Object.keys(fontSize);',
        TAG,
      ].join('\n'),
      { 'tokens.ts': tokensModule }
    );
    expectResolved(result.cssText);
  });

  it('resolves when an imported helper consumes an unrelated import', async () => {
    const result = await runStatic(
      [
        HEADER,
        "import { makeTheme } from './runtime';",
        "import { palette } from './palette';",
        "import { space } from './tokens';",
        '',
        'const theme = makeTheme(palette);',
        TAG,
      ].join('\n'),
      {
        'tokens.ts': tokensModule,
        'palette.ts': 'export const palette = {accent: "#f00"};',
        'runtime.ts': 'export const makeTheme = (p: unknown) => ({...(p as object)});',
      }
    );
    expectResolved(result.cssText);
  });
});
