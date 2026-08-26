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

const TOKENS = dedent`
  export const themeVars = {
    borderSeparator: 'var(--borderSeparator)',
    borderSeparatorDimmed: 'var(--borderSeparatorDimmed)',
  };
  export const textClasses = { regular: 'regular', small: 'small' };
`;

/**
 * `cx` is a plain runtime class-name concatenator, not a processor -- the same
 * role `cx` from '@linaria/core' plays in an app.
 */
const runStatic = async (source: string) => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-cx-order-'));
  const entryFile = join(root, 'entry.tsx');
  writeFileSync(join(root, 'tokens.ts'), TOKENS);
  writeFileSync(entryFile, source);

  try {
    return await transform(
      {
        cache: new TransformCacheCollection(),
        options: {
          filename: entryFile,
          root,
          pluginOptions: {
            configFile: false,
            eval: { require: 'off', strategy: 'static' },
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

const HEADER = dedent`
  import { css, cx } from 'test-css-processor';
  import { textClasses, themeVars } from './tokens';
`;

const FIRST = 'const a = css`border-top: ${themeVars.borderSeparator};`;';
const SECOND =
  'const b = css`border-top: ${themeVars.borderSeparatorDimmed};`;';
const CX_WITH_CSS = 'const g = cx(textClasses.regular, css`min-height: 0;`);';
const CX_WITHOUT_CSS = 'const g = cx(textClasses.regular, textClasses.small);';
const PLAIN_CSS = 'const p = css`display: none;`;';
const CX_LITERALS_ONLY = "const g = cx('one', 'two');";
const CX_CSS_ONLY = 'const g = cx(css`min-height: 0;`);';
const LOCAL_CALL_WITH_IMPORT = [
  'const identity = (value) => value;',
  'const g = identity(textClasses.regular);',
].join('\n');

const source = (...parts: string[]) =>
  [HEADER, '', ...parts, '', 'export const all = [a, b];'].join('\n');

/**
 * A module-level `cx(...)` call must not affect whether `css` tags declared
 * after it can have their interpolations resolved statically.
 *
 * Regression introduced between 2.3.1 and 2.4.0: once a `cx(...)` call appears
 * at module scope, every *later* `css` tag's interpolations stop resolving and
 * `eval.strategy: "static"` fails with unattributed `_expN` placeholders.
 * Declarations before the `cx(...)` are unaffected, which is why the failure
 * count tracks the number of interpolated tags that follow it.
 *
 * This is what broke fibery-ui under 2.4.3, and why hoisting a `css` tag above
 * the file's `cx(...)` made the error go away without changing any styles.
 */
describe('static eval of css tags declared after a module-level cx()', () => {
  const expectResolved = (cssText: string) => {
    expect(cssText).toContain('border-top:var(--borderSeparator)');
    expect(cssText).toContain('border-top:var(--borderSeparatorDimmed)');
  };

  it('resolves both tags when no cx() is present', async () => {
    const result = await runStatic(source(FIRST, SECOND));
    expectResolved(result.cssText);
  });

  it('resolves both tags when cx() comes last', async () => {
    const result = await runStatic(source(FIRST, SECOND, CX_WITH_CSS));
    expectResolved(result.cssText);
  });

  it('resolves both tags when cx() comes first', async () => {
    const result = await runStatic(source(CX_WITH_CSS, FIRST, SECOND));
    expectResolved(result.cssText);
  });

  it('resolves the tag that follows a cx() in the middle', async () => {
    const result = await runStatic(source(FIRST, CX_WITH_CSS, SECOND));
    expectResolved(result.cssText);
  });

  // `cx` need not receive a `css` tag at all -- concatenating two imported
  // class names is enough to break every interpolation that follows.
  it('resolves tags after a cx() that takes no css argument', async () => {
    const result = await runStatic(source(CX_WITHOUT_CSS, FIRST, SECOND));
    expectResolved(result.cssText);
  });

  it('resolves a tag declared after both a plain css tag and a cx()', async () => {
    const result = await runStatic(
      source(PLAIN_CSS, CX_WITH_CSS, FIRST, SECOND)
    );
    expectResolved(result.cssText);
  });

  // Control: a cx() followed only by non-interpolated tags always worked, so
  // this must keep working and pins the failure to the interpolations.
  it('resolves when nothing interpolated follows the cx()', async () => {
    const result = await runStatic(
      source(FIRST, SECOND, CX_WITH_CSS, PLAIN_CSS)
    );
    expectResolved(result.cssText);
  });

  // The trigger is an *imported* argument, not the cx() call itself. These
  // controls pass today and bound the defect: keeping them green stops a fix
  // from being written as "treat every preceding call as safe".
  it('resolves after a cx() called with only literals', async () => {
    const result = await runStatic(source(CX_LITERALS_ONLY, FIRST, SECOND));
    expectResolved(result.cssText);
  });

  it('resolves after a cx() called with only a css tag', async () => {
    const result = await runStatic(source(CX_CSS_ONLY, FIRST, SECOND));
    expectResolved(result.cssText);
  });

  it('resolves after a local function called with an imported binding', async () => {
    const result = await runStatic(
      source(LOCAL_CALL_WITH_IMPORT, FIRST, SECOND)
    );
    expectResolved(result.cssText);
  });
});
