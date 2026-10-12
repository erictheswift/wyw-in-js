const transformMock = jest.fn();

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  disposeEvalBroker: jest.fn(),
  getFileIdx: () => 'file',
  TransformCacheCollection: function TransformCacheCollection() {
    return { get: () => undefined };
  },
  transform: (...args: unknown[]) => transformMock(...args),
}));

// A query gives this file its own copy of the plugin, bound to the mocks above.
// eslint-disable-next-line import/no-unresolved
const loadWywInJS = () => import('../index?add-watch-file');

const createContext = (resolved: Record<string, object | null> = {}) => ({
  addWatchFile: jest.fn(),
  meta: { rollupVersion: '4.0.0' },
  resolve: jest.fn(async (what: string) => resolved[what] ?? null),
  warn: jest.fn(),
});

describe('@wyw-in-js/rollup addWatchFile', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('registers resolved dependency files outside node_modules', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const plugin = wywInJS({ serializeTransform: false });
    transformMock.mockResolvedValue({
      code: 'export const a = "a";',
      cssText: '.a{color:red}',
      dependencies: [
        './theme',
        'tokens',
        './runtime',
        './virtual',
        './missing',
        '/abs/src/palette.ts',
        '/abs/node_modules/lib/index.js',
      ],
      dependencyResolutions: [
        { source: './theme', resolved: '/abs/src/theme.ts?v=1' },
        { source: 'tokens', resolved: '/abs/node_modules/tokens/index.js' },
      ],
      sourceMap: null,
    });
    const ctx = createContext({
      './runtime': { id: '/abs/src/run#time.ts', external: false },
      './virtual': { id: '\0virtual', external: false },
    });

    await plugin.transform!.call(ctx as any, 'code', '/abs/src/entry.ts');

    expect(ctx.addWatchFile.mock.calls).toEqual([
      ['/abs/src/theme.ts'],
      ['/abs/src/run#time.ts'],
      ['/abs/src/palette.ts'],
    ]);
  });

  it('registers dependencies of a transform without CSS', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const plugin = wywInJS({ serializeTransform: false });
    transformMock.mockResolvedValue({
      code: 'export const a = "a";',
      cssText: '',
      dependencies: ['./theme'],
      dependencyResolutions: [{ source: './theme', resolved: '/abs/theme.ts' }],
      sourceMap: null,
    });
    const ctx = createContext();

    await plugin.transform!.call(ctx as any, 'code', '/abs/entry.ts');

    expect(ctx.addWatchFile.mock.calls).toEqual([['/abs/theme.ts']]);
  });

  it('works with a Rollup that has no addWatchFile', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const plugin = wywInJS({ serializeTransform: false });
    transformMock.mockResolvedValue({
      code: 'export const a = "a";',
      cssText: '.a{color:red}',
      dependencies: ['./theme'],
      dependencyResolutions: [{ source: './theme', resolved: '/abs/theme.ts' }],
      sourceMap: null,
    });
    const { addWatchFile, ...ctx } = createContext();

    await expect(
      plugin.transform!.call(ctx as any, 'code', '/abs/entry.ts')
    ).resolves.toMatchObject({ code: expect.any(String) });
    expect(addWatchFile).not.toHaveBeenCalled();
  });
});
