import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runWatchScenario } from './watch-importer-first.mjs';

// A loader before wyw changes the code of modules that export components, as
// Storybook's react-docgen-loader does. That code differs from the file the
// importers of the module read from disk, but it is not an edit of the file:
// every edit must still reach the CSS of all modules, including a module that
// gets a value through a re-exporting module.

const docgenLikeLoader = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'docgen-like-loader.cjs'
);

const cssImport = "import { css } from '@wyw-in-js/template-tag-syntax';";

const tokens = (size) => `export const size = (() => '${size}')();\n`;

const image = (suffix) =>
  [
    cssImport,
    "import { size } from './tokens';",
    '',
    `export const imageSize = (() => \`\${size}${suffix}\`)();`,
    'export const Image = () => null;',
    'export const image = css`width: ${imageSize};`;',
    '',
  ].join('\n');

const badge = (property) =>
  [
    cssImport,
    "import { imageSize } from './Image';",
    '',
    "export { imageSize } from './Image';",
    'export const Badge = () => null;',
    `export const badge = css\`${property}: \${imageSize};\`;`,
    '',
  ].join('\n');

const page = [
  cssImport,
  "import { badge, imageSize } from './Badge';",
  '',
  'export const page = css`max-width: ${imageSize}; & .${badge} { margin: 0; }`;',
  '',
].join('\n');

const index = [
  "import { image } from './Image';",
  "import { page } from './Page';",
  '',
  'export default [image, page];',
  '',
].join('\n');

const expectedCss = (size, badgeProperty = 'min-width') => ({
  Badge: [`${badgeProperty}:${size};`],
  Image: [`width:${size};`],
  Page: [`max-width:${size};`, 'margin:0;'],
});

const scenarios = [
  {
    name: 'modules changed by a loader before wyw',
    loaders: [docgenLikeLoader],
    files: {
      'tokens.js': tokens('16px'),
      'Image.js': image(''),
      'Badge.js': badge('min-width'),
      'Page.js': page,
      'index.js': index,
    },
    cold: expectedCss('16px'),
    edits: [
      {
        files: { 'tokens.js': tokens('20px') },
        css: expectedCss('20px'),
      },
      {
        files: { 'Image.js': image('-a') },
        css: expectedCss('20px-a'),
      },
      {
        files: { 'Badge.js': badge('min-height') },
        css: expectedCss('20px-a', 'min-height'),
      },
    ],
  },
];

export async function assertWatchLoaderOutput(pkgDir, bundler, bundlerName) {
  for (const scenario of scenarios) {
    await runWatchScenario(pkgDir, bundler, bundlerName, scenario);
  }
}
