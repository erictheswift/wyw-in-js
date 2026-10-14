/**
 * #422: a loader before wyw (Storybook's react-docgen-loader) appends a
 * statement to a module, so the code its root is created with differs from
 * the bytes its importers read from disk. Nothing changed on disk, so the
 * importers stay current; an edit before the root is created still
 * invalidates them.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';

const processorFile = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const imageCode = dedent`
  import { css } from 'test-css-processor';

  export const IMAGE_ERROR = 'img-error';
  export const Image = () => null;
  export const image = css\`color: blue;\`;
`;

const bgCode = dedent`
  import { css } from 'test-css-processor';
  import { IMAGE_ERROR, Image } from './image';

  const mix = (color: string) => color + '-mixed';

  export const gradient = mix('red');
  export const BackgroundImage = () => Image();
  export const fallback = css\`
    background: \${gradient};
    & .\${IMAGE_ERROR} { color: blue; }
  \`;
`;

const heroCode = dedent`
  import { css } from 'test-css-processor';
  import { gradient } from './bg';

  export const hero = css\`background: \${gradient};\`;
`;

const docgen = (code: string) =>
  `${code}\nImage.__docgenInfo = { displayName: 'Image' };\n`;

const setup = () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-loader-output-root-'))
  );
  const file = (name: string) => path.join(root, name);
  fs.writeFileSync(file('image.ts'), imageCode);
  fs.writeFileSync(file('bg.ts'), bgCode);
  fs.writeFileSync(file('hero.ts'), heroCode);

  const cache = new TransformCacheCollection();
  const asyncResolve = async (what: string, importer: string) =>
    what === 'test-css-processor'
      ? processorFile
      : `${path.resolve(path.dirname(importer), what)}.ts`;
  const run = (name: string, code: string) =>
    transform(
      {
        cache,
        options: {
          filename: file(name),
          root,
          pluginOptions: {
            configFile: false,
            tagResolver: (source, tag) =>
              source === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
            babelOptions: {
              babelrc: false,
              configFile: false,
              presets: ['@babel/preset-typescript'],
            },
          },
        },
      },
      code,
      asyncResolve
    );

  return { cache, file, root, run };
};

describe('a root created from loader output that differs from disk', () => {
  it('keeps the importers that read the module from disk', async () => {
    const { cache, file, root, run } = setup();
    try {
      await run('hero.ts', heroCode);
      await run('bg.ts', bgCode);
      const bg = cache.get('entrypoints', file('bg.ts'));
      expect(bg).toBeDefined();

      const image = await run('image.ts', docgen(imageCode));
      expect(image.cssText).toContain('color:blue');

      const hero = await run('hero.ts', heroCode);
      expect(hero.cssText).toContain('background:red-mixed');
      expect(cache.get('entrypoints', file('bg.ts')) === bg).toBe(true);
    } finally {
      disposeEvalBroker(cache);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('still invalidates the importers when the file changed on disk', async () => {
    const { cache, file, root, run } = setup();
    try {
      await run('hero.ts', heroCode);
      await run('bg.ts', bgCode);
      const bg = cache.get('entrypoints', file('bg.ts'));

      const edited = imageCode.replace("'img-error'", "'img-failed'");
      fs.writeFileSync(file('image.ts'), edited);
      await run('image.ts', docgen(edited));

      const bgResult = await run('bg.ts', bgCode);
      expect(bgResult.cssText).toContain('.img-failed');
      expect(cache.get('entrypoints', file('bg.ts')) === bg).toBe(false);
    } finally {
      disposeEvalBroker(cache);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
