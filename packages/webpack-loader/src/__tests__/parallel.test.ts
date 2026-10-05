const transformMock = jest.fn();
const poolTransformMock = jest.fn();
const poolDisposeMock = jest.fn();
const createTransformPoolMock = jest.fn();

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  logger: jest.fn(),
  mergeOxcResolverAlias: (oxcOptions: any) => oxcOptions,
  toNativeResolverAlias: jest.fn(() => ({})),
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  createFileReporter: () => ({
    emitter: { single: jest.fn() },
    onDone: jest.fn(),
  }),
  createTransformPool: (...args: unknown[]) => createTransformPoolMock(...args),
  getDefaultTransformPoolSize: () => 3,
  TransformCacheCollection: function TransformCacheCollection() {},
  transform: (...args: unknown[]) => transformMock(...args),
  disposeEvalBroker: jest.fn(),
}));

const createHook = <TArgs extends unknown[]>() => {
  const handlers: Array<(...args: TArgs) => void> = [];

  return {
    call: (...args: TArgs) => {
      handlers.forEach((handler) => handler(...args));
    },
    tap: (_name: string, handler: (...args: TArgs) => void) => {
      handlers.push(handler);
    },
  };
};

const createCompiler = () => ({
  hooks: {
    done: createHook<[unknown]>(),
    failed: createHook<[Error]>(),
    shutdown: createHook<[]>(),
    watchClose: createHook<[]>(),
  },
});

const result = {
  code: 'export const title = "title";',
  cssText: '.title{color:red}',
  dependencies: [],
  sourceMap: null,
};

const runLoader = async ({
  addDependency = jest.fn(),
  compiler,
  parallel,
  resolveModule = jest.fn((_ctx, _request, cb) => cb(null, null)),
}: {
  addDependency?: jest.Mock;
  compiler?: ReturnType<typeof createCompiler>;
  parallel: boolean | number;
  resolveModule?: jest.Mock;
}) => {
  const { default: webpackLoader } = await import('../index');

  return new Promise<string>((resolve, reject) => {
    webpackLoader.call(
      {
        _compiler: compiler,
        addDependency,
        async: jest.fn(),
        callback: (err: Error | null, code?: string) =>
          err ? reject(err) : resolve(String(code)),
        context: '/abs',
        emitWarning: jest.fn(),
        getDependencies: () => [],
        getOptions: () => ({ configFile: '/abs/wyw.config.cjs', parallel }),
        getResolve: () => resolveModule,
        resourcePath: '/abs/entry.tsx',
        rootContext: '/abs',
        utils: { contextify: (_ctx: string, request: string) => request },
      } as any,
      'export const title = css``;',
      null
    );
  });
};

describe('webpack-loader parallel', () => {
  beforeEach(() => {
    transformMock.mockReset();
    poolTransformMock.mockReset();
    poolDisposeMock.mockReset();
    createTransformPoolMock.mockReset();
    createTransformPoolMock.mockImplementation(() => ({
      dispose: poolDisposeMock,
      transform: poolTransformMock,
    }));
  });

  it('transforms through one pool per compiler and emits the CSS request', async () => {
    const compiler = createCompiler();
    poolTransformMock.mockResolvedValue(result);

    const first = await runLoader({ compiler, parallel: 2 });
    await runLoader({ compiler, parallel: 2 });

    expect(transformMock).not.toHaveBeenCalled();
    expect(createTransformPoolMock).toHaveBeenCalledTimes(1);
    expect(createTransformPoolMock.mock.calls[0][0]).toMatchObject({
      pluginOptions: { configFile: '/abs/wyw.config.cjs' },
      workers: 2,
    });
    expect(poolTransformMock.mock.calls[0][0]).toMatchObject({
      filename: '/abs/entry.tsx',
      root: process.cwd(),
    });
    expect(first).toContain(result.code);
    expect(first).toContain('outputCssPayload=');
  });

  it('routes pooled resolutions to the resolver of the root file', async () => {
    const compiler = createCompiler();
    const addDependency = jest.fn();
    const resolveModule = jest.fn((_ctx, _request, cb) =>
      cb(null, '/abs/tokens.ts')
    );
    poolTransformMock.mockImplementation(async () => {
      const [{ asyncResolve }] = createTransformPoolMock.mock.calls[0];
      await asyncResolve('./tokens', '/abs/entry.tsx', ['/abs/entry.tsx']);
      return result;
    });

    await runLoader({ addDependency, compiler, parallel: true, resolveModule });

    expect(createTransformPoolMock.mock.calls[0][0]).toMatchObject({
      workers: 3,
    });
    expect(resolveModule).toHaveBeenCalledWith(
      '/abs',
      './tokens',
      expect.any(Function)
    );
    expect(addDependency).toHaveBeenCalledWith('/abs/tokens.ts');
  });

  it('disposes the pool with the compiler', async () => {
    const compiler = createCompiler();
    poolTransformMock.mockResolvedValue(result);

    await runLoader({ compiler, parallel: 2 });
    compiler.hooks.shutdown.call();

    expect(poolDisposeMock).toHaveBeenCalledTimes(1);
  });

  it('transforms in-process when there is no compiler to own workers', async () => {
    transformMock.mockResolvedValue(result);

    await runLoader({ parallel: 2 });

    expect(createTransformPoolMock).not.toHaveBeenCalled();
    expect(transformMock).toHaveBeenCalledTimes(1);
  });
});
