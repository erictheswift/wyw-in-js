import path from 'path';

import * as babel from '@babel/core';

import type { StrictOptions } from '@wyw-in-js/shared';
import { logger } from '@wyw-in-js/shared';

import { TransformCacheCollection } from '../cache';
import { Entrypoint } from '../transform/Entrypoint';
import type { LoadAndParseFn } from '../transform/Entrypoint.types';
import { asyncResolveImports } from '../transform/generators/resolveImports';
import type { IResolveImportsAction, Services } from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';

const createPluginOptions = (
  overrides: StrictOptions['importOverrides']
): StrictOptions => ({
  babelOptions: {},
  displayName: false,
  extensions: ['.cjs', '.js', '.jsx', '.ts', '.tsx'],
  features: {
    dangerousCodeRemover: true,
    globalCache: true,
    happyDOM: true,
    softErrors: false,
    useBabelConfigs: true,
    useWeakRefInEval: true,
  },
  highPriorityPlugins: [],
  importOverrides: overrides,
  rules: [],
});

const createServices = ({
  filename,
  pluginOptions,
  root,
}: {
  filename: string;
  pluginOptions: StrictOptions;
  root: string;
}): Services => {
  const loadAndParseFn: LoadAndParseFn = (services, _name, loadedCode) => ({
    get ast() {
      return services.babel.parseSync(loadedCode ?? '')!;
    },
    code: loadedCode ?? '',
    evaluator: jest.fn(),
    evalConfig: {},
  });

  return {
    babel,
    cache: new TransformCacheCollection(),
    loadAndParseFn,
    log: logger,
    eventEmitter: EventEmitter.dummy,
    options: {
      filename,
      root,
      pluginOptions,
    },
  };
};

// The handler transform() installs for the `resolveImports` action.
const resolveImports = async (
  action: IResolveImportsAction,
  resolve: (what: string) => string
) => {
  const result = await asyncResolveImports
    .call(action, async (what) => resolve(what))
    .next();

  return result.value;
};

describe('resolveImports: importOverrides', () => {
  it('applies file-key overrides based on resolved path', async () => {
    const root = '/project';
    const pluginOptions = createPluginOptions({
      './src/foo.js': { noShake: true },
    });

    const services = createServices({
      filename: '/project/src/a.js',
      root,
      pluginOptions,
    });

    const resolve = () => '/project/src/foo.js';

    const entrypointA = Entrypoint.createRoot(
      services,
      '/project/src/a.js',
      ['*'],
      ''
    );
    const actionA = {
      data: { imports: new Map([['./foo', ['default']]]) },
      entrypoint: entrypointA,
      services,
    } as IResolveImportsAction;

    const depsA = await resolveImports(actionA, resolve);
    expect(depsA).toEqual([
      {
        source: './foo',
        only: ['*'],
        resolved: '/project/src/foo.js',
      },
    ]);

    const entrypointB = Entrypoint.createRoot(
      services,
      '/project/other/b.js',
      ['*'],
      ''
    );
    const actionB = {
      data: { imports: new Map([['../src/foo.js', ['named']]]) },
      entrypoint: entrypointB,
      services,
    } as IResolveImportsAction;

    const depsB = await resolveImports(actionB, resolve);
    expect(depsB).toEqual([
      {
        source: '../src/foo.js',
        only: ['*'],
        resolved: '/project/src/foo.js',
      },
    ]);
  });

  it('supports glob patterns for file-key overrides', async () => {
    const root = '/project';
    const pluginOptions = createPluginOptions({
      './src/*.js': { noShake: true },
    });

    const services = createServices({
      filename: '/project/src/a.js',
      root,
      pluginOptions,
    });

    const resolve = () => '/project/src/foo.js';

    const entrypoint = Entrypoint.createRoot(
      services,
      '/project/src/a.js',
      ['*'],
      ''
    );
    const action = {
      data: { imports: new Map([['./foo', ['default']]]) },
      entrypoint,
      services,
    } as IResolveImportsAction;

    const deps = await resolveImports(action, resolve);
    expect(deps).toEqual([
      {
        source: './foo',
        only: ['*'],
        resolved: '/project/src/foo.js',
      },
    ]);
  });

  it('reuses pre-resolved file imports and still applies file-key noShake overrides', async () => {
    const root = '/project';
    const pluginOptions = createPluginOptions({
      './src/foo.js': { noShake: true },
    });

    const services = createServices({
      filename: '/project/src/a.js',
      root,
      pluginOptions,
    });

    const resolve = jest.fn(() => {
      throw new Error('resolver should not be called for pre-resolved imports');
    });

    const entrypoint = Entrypoint.createRoot(
      services,
      '/project/src/a.js',
      ['*'],
      ''
    );
    const action = {
      data: {
        imports: new Map([['/project/src/foo.js', ['default']]]),
        preResolved: [
          {
            source: '/project/src/foo.js',
            only: ['default'],
            resolved: '/project/src/foo.js',
          },
        ],
      },
      entrypoint,
      services,
    } as IResolveImportsAction;

    const deps = await resolveImports(action, resolve);
    expect(deps).toEqual([
      {
        source: '/project/src/foo.js',
        only: ['*'],
        resolved: '/project/src/foo.js',
      },
    ]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('reuses pre-resolved file imports and still applies file-key mock overrides', async () => {
    const root = __dirname;
    const sourceFile = path.join(root, 'src', 'foo.js');
    const mockSpecifier = './__fixtures__/sample-script.js';

    const pluginOptions = createPluginOptions({
      './src/foo.js': { mock: mockSpecifier },
    });

    const services = createServices({
      filename: path.join(root, 'a.js'),
      root,
      pluginOptions,
    });

    const resolve = jest.fn(() => {
      throw new Error('resolver should not be called for pre-resolved imports');
    });

    const entrypoint = Entrypoint.createRoot(
      services,
      path.join(root, 'a.js'),
      ['*'],
      ''
    );
    const action = {
      data: {
        imports: new Map([[sourceFile, ['default']]]),
        preResolved: [
          {
            source: sourceFile,
            only: ['default'],
            resolved: sourceFile,
          },
        ],
      },
      entrypoint,
      services,
    } as IResolveImportsAction;

    const deps = await resolveImports(action, resolve);
    expect(deps).toEqual([
      {
        source: sourceFile,
        only: ['default'],
        resolved: require.resolve(path.resolve(root, mockSpecifier)),
      },
    ]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('applies package-key overrides by source specifier', async () => {
    const root = __dirname;
    const mockSpecifier = './__fixtures__/sample-script.js';

    const pluginOptions = createPluginOptions({
      react: {
        mock: mockSpecifier,
      },
    });

    const services = createServices({
      filename: path.join(root, 'a.js'),
      root,
      pluginOptions,
    });

    const entrypoint = Entrypoint.createRoot(
      services,
      path.join(root, 'a.js'),
      ['*'],
      ''
    );
    const action = {
      data: { imports: new Map([['react', ['default']]]) },
      entrypoint,
      services,
    } as IResolveImportsAction;

    const deps = await resolveImports(action, () => '/external/react.js');

    expect(deps).toEqual([
      {
        source: 'react',
        only: ['default'],
        resolved: require.resolve(path.resolve(root, mockSpecifier)),
      },
    ]);
  });
});
