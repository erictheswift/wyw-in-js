import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { SourceMapConsumer } from 'source-map';

const require = createRequire(import.meta.url);

export const assertAssetSourceMaps = async (pkgDir, useRspack) => {
  const bundler = require(useRspack ? '@rspack/core' : 'webpack');
  const dir = await fs.mkdtemp(path.join(pkgDir, 'asset-sourcemaps-'));
  const entry = path.join(dir, 'entry.js');
  const source =
    "import { css } from '@wyw-in-js/template-tag-syntax';\nexport const title = css`color: red;`;\n";
  await fs.writeFile(entry, source);
  try {
    for (const maps of [false, true]) {
      for (const postcss of [false, true]) {
        const out = path.join(dir, `${maps}-${postcss}`);
        const compiler = bundler({
          mode: 'development',
          context: pkgDir,
          entry,
          devtool: false,
          cache: false,
          output: { path: out, filename: 'bundle.js' },
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
                type: 'asset/resource',
                generator: { filename: 'styles.css' },
                ...(postcss
                  ? {
                      use: [
                        {
                          loader: require.resolve('postcss-loader'),
                          options: {
                            sourceMap: maps,
                            postcssOptions: { config: false, plugins: [] },
                          },
                        },
                      ],
                    }
                  : {}),
              },
            ],
          },
        });
        try {
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
          const color = /color:\s*red\b/.exec(css);
          assert(color, `Expected red CSS, got ${css}`);
          const inlineMaps = [
            ...css.matchAll(
              /sourceMappingURL=data:application\/json;base64,([^*]+)\*\//g
            ),
          ];
          assert.equal(inlineMaps.length, maps ? 1 : 0);
          if (maps) {
            const map = JSON.parse(
              Buffer.from(inlineMaps[0][1], 'base64').toString()
            );
            assert.deepEqual(map.sourcesContent, [source]);
            await SourceMapConsumer.with(map, null, (consumer) => {
              const original = consumer.originalPositionFor({
                line: 1,
                column: color.index,
              });
              assert.equal(consumer.sourceContentFor(original.source), source);
              assert.equal(original.line, 2);
            });
          }
        } finally {
          await new Promise((resolve, reject) =>
            compiler.close((error) => (error ? reject(error) : resolve()))
          );
        }
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

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
          assert(
            new RegExp(`color:\\s*${color}\\b`).test(css),
            `Expected ${color} CSS, got ${css}`
          );
          assert(/border:\s*1px solid blue/.test(css));
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
              for (const [property, content, line] of [
                [
                  new RegExp(`color:\\s*${color}\\b`),
                  entrySource,
                  3 + padding.length,
                ],
                [/border:\s*1px solid blue/, secondSource, 2],
              ]) {
                const prefix = css.slice(0, css.search(property));
                const original = consumer.originalPositionFor({
                  line: prefix.split('\n').length,
                  column: prefix.length - prefix.lastIndexOf('\n') - 1,
                });
                assert.equal(
                  consumer.sourceContentFor(original.source),
                  content
                );
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
  await assertAssetSourceMaps(pkgDir, useRspack);
};
