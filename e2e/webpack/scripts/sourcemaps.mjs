import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { SourceMapConsumer } from 'source-map';

const require = createRequire(import.meta.url);

export const assertSourceMaps = async (pkgDir, useRspack) => {
  const bundler = require(useRspack ? '@rspack/core' : 'webpack');
  const Extract = useRspack
    ? bundler.CssExtractRspackPlugin
    : require('mini-css-extract-plugin');
  const dir = await fs.mkdtemp(path.join(pkgDir, 'sourcemaps-'));
  const entry = path.join(dir, 'entry.js');
  const second = path.join(dir, 'second.js');
  const source = (color, padding = '') =>
    `${padding}import './second.js';\nimport { css } from '@wyw-in-js/template-tag-syntax';\nexport const title = css\`color: ${color};\`;\n`;
  const secondSource =
    "import { css } from '@wyw-in-js/template-tag-syntax';\nexport const second = css`border: 1px solid blue;`;\n";
  await fs.writeFile(second, secondSource);
  try {
    for (const [maps, devtool] of [
      [false, 'eval'],
      [true, 'eval'],
      [true, 'source-map'],
    ]) {
      const out = path.join(dir, maps ? devtool : 'plain');
      const loaderMapOptions =
        useRspack && maps && devtool === 'eval' ? { sourceMap: true } : {};
      const compiler = bundler({
        mode: 'development',
        context: pkgDir,
        entry,
        devtool,
        cache: false,
        ...(useRspack ? { experiments: { css: false } } : {}),
        output: { path: out, filename: 'bundle.js', pathinfo: false },
        module: {
          rules: [
            {
              test: /\.js$/,
              use: [
                {
                  loader: '@wyw-in-js/webpack-loader',
                  options: { sourceMap: maps },
                },
              ],
            },
            {
              test: /\.wyw-in-js\.css$/,
              use: [
                Extract.loader,
                {
                  loader: require.resolve('css-loader'),
                  options: { importLoaders: 1, ...loaderMapOptions },
                },
                {
                  loader: require.resolve('postcss-loader'),
                  options: {
                    ...loaderMapOptions,
                    postcssOptions: { config: false, plugins: [] },
                  },
                },
              ],
            },
          ],
        },
        plugins: [
          new Extract({ filename: 'styles.css' }),
          ...(maps && devtool === 'eval'
            ? [
                new bundler.SourceMapDevToolPlugin({
                  test: /\.css$/,
                  filename: '[file].map',
                }),
              ]
            : []),
        ],
      });
      let previousCss;
      let previousMap;
      try {
        for (const [index, [color, padding]] of [
          ['red', ''],
          ['red', '\n\n'],
          ['green', '\n\n'],
        ].entries()) {
          const entrySource = source(color, padding);
          await fs.writeFile(entry, entrySource);
          await new Promise((resolve, reject) =>
            compiler.run((error, stats) => {
              if (error || stats.hasErrors() || stats.hasWarnings()) {
                reject(
                  error ??
                    new Error(
                      stats.toString({
                        all: false,
                        errors: true,
                        warnings: true,
                      })
                    )
                );
              } else {
                resolve();
              }
            })
          );
          const css = await fs.readFile(path.join(out, 'styles.css'), 'utf8');
          assert(
            !css.includes('sourceMappingURL=data:'),
            'CSS must not contain inline source maps'
          );
          assert(css.includes(`color:${color}`));
          assert(css.includes('border:1px solid blue'));
          if (index === 1)
            assert.equal(
              css,
              previousCss,
              'Source-only edit must not change CSS'
            );
          if (maps) {
            const map = JSON.parse(
              await fs.readFile(path.join(out, 'styles.css.map'), 'utf8')
            );
            assert.equal(map.sources.length, 2);
            assert.equal(new Set(map.sources).size, 2);
            assert.deepEqual(
              new Set(map.sourcesContent),
              new Set([entrySource, secondSource])
            );
            if (index === 1)
              assert.notDeepEqual(
                map,
                previousMap,
                'Source-only edit must update the map'
              );
            await SourceMapConsumer.with(map, null, (consumer) => {
              for (const [property, suffix, line] of [
                [`color:${color}`, '/entry.js', 3 + padding.length],
                ['border:1px solid blue', '/second.js', 2],
              ]) {
                const prefix = css.slice(0, css.indexOf(property));
                const original = consumer.originalPositionFor({
                  line: prefix.split('\n').length,
                  column: prefix.length - prefix.lastIndexOf('\n') - 1,
                });
                assert(original.source.endsWith(suffix));
                assert.equal(original.line, line);
              }
            });
            previousMap = map;
          } else {
            assert(
              !(await fs.readdir(out)).some((name) => name.endsWith('.map'))
            );
          }
          previousCss = css;
        }
      } finally {
        await new Promise((resolve, reject) =>
          compiler.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};
