import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { Worker } from 'node:worker_threads';

import type { PartialOptions } from '../transform/helpers/loadWywOptions';
import { rootLog } from '../transform/rootLog';
import type { Result } from '../types';
import { MAX_PARSE_CACHE_ENTRIES } from '../utils/parseOxc';

import type {
  MainToWorker,
  TransformPoolJobOptions,
  TransformPoolWorkerData,
  WorkerToMain,
} from './protocol';
import { deserializeError, serializeError } from './protocol';

export type { TransformPoolJobOptions } from './protocol';

export type TransformPoolResolver = (
  what: string,
  importer: string,
  stack: string[]
) => Promise<string | null>;

export type TransformPoolOptions = {
  /**
   * Resolver shared by every job of the pool. Workers send each resolution
   * here with its import stack; an integration routes it to the request of the
   * root file (`stack.at(-1)`), as webpack-loader does for in-process calls.
   */
  asyncResolve: TransformPoolResolver;
  /** Stable semantic identity of `asyncResolve` (see `Services`). */
  asyncResolveKey?: string;
  /**
   * Parsed-AST cache entries per worker. Defaults to the in-process budget
   * divided between the workers.
   */
  parseCacheEntries?: number;
  /**
   * Plugin options for every job. They are cloned into each worker, so
   * function-valued options (classNameSlug, tagResolver, rules, …) must come
   * from a config file named by `configFile`.
   */
  pluginOptions?: PartialOptions;
  /**
   * Initial old-generation heap limit of each worker, in MB. Without one a
   * worker heap grows toward the process limit and mostly holds garbage. A
   * worker that runs out of memory is replaced by one with twice the limit and
   * its transforms are retried. An explicit `--max-old-space-size` for the
   * process overrides it, since V8 applies that flag to every isolate.
   */
  workerHeapLimitMb?: number;
  /** Maximum worker count. Workers start lazily as the queue grows. */
  workers?: number;
};

export type TransformPool = {
  dispose: () => Promise<void>;
  transform: (
    options: TransformPoolJobOptions,
    code: string,
    emitWarning?: (message: string) => void
  ) => Promise<Result>;
};

type TransformRequest = Omit<
  Extract<MainToWorker, { type: 'transform' }>,
  'id'
>;

type Job = {
  emitWarning?: (message: string) => void;
  reject: (error: Error) => void;
  request: TransformRequest;
  resolve: (result: Result) => void;
};

type Slot = {
  jobs: Map<number, Job>;
  worker: Worker;
};

type Utilization = ReturnType<Worker['performance']['eventLoopUtilization']>;

// Every worker re-caches the shared dependency graph, so one more is worth its
// memory only when the workers limit throughput: all of them busy computing
// while the bundler thread idles waiting for their results. A busy bundler
// thread is the bottleneck itself; another worker would add memory, and
// duplicated analysis would keep it busy without speeding anything up.
const SATURATED_UTILIZATION = 0.9;
const BUNDLER_IDLE_UTILIZATION = 0.9;
const SCALE_WINDOW_MS = 250;
// Bun does not implement Worker#performance; scale by queued jobs there.
const JOBS_PER_WORKER_BEFORE_SCALING = 4;
const measuresUtilization = !process.versions.bun;
// Measured on a large webpack app: 2 workers held 0.6-0.95 GB each at this
// limit with no time cost, 1.2-1.4 GB each without one.
const DEFAULT_WORKER_HEAP_LIMIT_MB = 1536;
const MAX_WORKER_HEAP_LIMIT_MB = Math.floor(
  getHeapStatistics().heap_size_limit / 1024 / 1024
);
// V8 applies an explicit --max-old-space-size to every isolate and it takes
// precedence over Worker resourceLimits, so workerHeapLimitMb is inert then.
const hasExplicitHeapLimit = [
  ...process.execArgv,
  ...(process.env.NODE_OPTIONS ?? '').split(' '),
].some(
  (arg) =>
    arg.startsWith('--max-old-space-size') || arg.startsWith('--max-heap-size')
);

let poolId = 0;

const log = rootLog.extend('pool');

export const getDefaultTransformPoolSize = (): number =>
  Math.max(1, Math.min(4, availableParallelism() - 1));

const buildWorkerPath = (): string => {
  const jsPath = fileURLToPath(new URL('./worker.js', import.meta.url));
  if (existsSync(jsPath)) {
    return jsPath;
  }

  return fileURLToPath(new URL('./worker.ts', import.meta.url));
};

const findFunctionOption = (value: unknown, path: string): string | null => {
  if (typeof value === 'function' || typeof value === 'symbol') {
    return path;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findFunctionOption(item, `${path}[${index}]`);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (value && typeof value === 'object' && !(value instanceof RegExp)) {
    for (const [key, item] of Object.entries(value)) {
      const found = findFunctionOption(item, `${path}.${key}`);
      if (found) {
        return found;
      }
    }
  }

  return null;
};

export const createTransformPool = ({
  asyncResolve,
  asyncResolveKey,
  parseCacheEntries,
  pluginOptions = {},
  workerHeapLimitMb = DEFAULT_WORKER_HEAP_LIMIT_MB,
  workers = getDefaultTransformPoolSize(),
}: TransformPoolOptions): TransformPool => {
  poolId += 1;
  const functionOption = findFunctionOption(pluginOptions, 'pluginOptions');
  if (functionOption) {
    throw new Error(
      `[wyw-in-js] ${functionOption} is a function, which cannot be sent to transform pool workers. ` +
        'Move function-valued options into a WyW config file and pass its path as configFile.'
    );
  }

  const maxWorkers = Math.max(1, Math.floor(workers));
  const resolverKey = asyncResolveKey ?? `transform-pool:${poolId}`;
  const workerPath = buildWorkerPath();
  const slots: Slot[] = [];
  const utilizationBaselines = new Map<Slot, Utilization>();
  let bundlerBaseline = measuresUtilization
    ? performance.eventLoopUtilization()
    : undefined;
  let lastScaleCheckAt = 0;
  let nextJobId = 0;
  let disposed = false;
  let heapLimitMb = Math.min(workerHeapLimitMb, MAX_WORKER_HEAP_LIMIT_MB);
  if (hasExplicitHeapLimit) {
    log(
      'an explicit --max-old-space-size applies to every worker and overrides workerHeapLimitMb (%d MB)',
      heapLimitMb
    );
  }
  let redispatch: (job: Job) => void = () => {};

  const getParseCacheEntries = (workerCount: number) =>
    parseCacheEntries ?? Math.ceil(MAX_PARSE_CACHE_ENTRIES / workerCount);

  const settle = (slot: Slot, id: number) => {
    const job = slot.jobs.get(id);
    if (slot.jobs.delete(id) && slot.jobs.size === 0) {
      slot.worker.unref();
    }
    return job;
  };

  const removeSlot = (slot: Slot): Job[] => {
    const index = slots.indexOf(slot);
    if (index !== -1) {
      slots.splice(index, 1);
    }
    utilizationBaselines.delete(slot);
    return [...slot.jobs.keys()]
      .map((id) => settle(slot, id))
      .filter((job): job is Job => job !== undefined);
  };

  const failSlot = (slot: Slot, error: Error) => {
    removeSlot(slot).forEach((job) => job.reject(error));
  };

  const onWorkerError = (slot: Slot, error: Error) => {
    const { code } = error as { code?: unknown };
    if (
      code !== 'ERR_WORKER_OUT_OF_MEMORY' ||
      heapLimitMb >= MAX_WORKER_HEAP_LIMIT_MB
    ) {
      failSlot(slot, error);
      return;
    }

    const retried = removeSlot(slot);
    heapLimitMb = Math.min(heapLimitMb * 2, MAX_WORKER_HEAP_LIMIT_MB);
    log(
      'worker ran out of memory, retrying %d transforms with a %d MB heap limit',
      retried.length,
      heapLimitMb
    );
    retried.forEach((job) => redispatch(job));
  };

  const onMessage = (slot: Slot, message: WorkerToMain) => {
    if (message.type === 'resolve') {
      const reply = (response: MainToWorker) =>
        slot.worker.postMessage(response);
      asyncResolve(message.what, message.importer, message.stack).then(
        (result) =>
          reply({ requestId: message.requestId, result, type: 'resolved' }),
        (error: unknown) =>
          reply({
            error: serializeError(error),
            requestId: message.requestId,
            type: 'resolve-failed',
          })
      );
      return;
    }

    if (message.type === 'warning') {
      slot.jobs.get(message.id)?.emitWarning?.(message.message);
      return;
    }

    const job = settle(slot, message.id);
    if (message.type === 'result') {
      job?.resolve(message.result);
    } else {
      job?.reject(deserializeError(message.error));
    }
  };

  const spawn = (): Slot => {
    const entries = getParseCacheEntries(slots.length + 1);
    slots.forEach((running) =>
      running.worker.postMessage({
        entries,
        type: 'parse-cache-limit',
      } satisfies MainToWorker)
    );
    const workerData: TransformPoolWorkerData = {
      asyncResolveKey: resolverKey,
      parseCacheEntries: entries,
      pluginOptions,
    };
    const slot: Slot = {
      jobs: new Map(),
      worker: new Worker(workerPath, {
        resourceLimits: { maxOldGenerationSizeMb: heapLimitMb },
        workerData,
      }),
    };
    slot.worker.unref();
    if (measuresUtilization) {
      utilizationBaselines.set(
        slot,
        slot.worker.performance.eventLoopUtilization()
      );
    }
    slot.worker.on('message', (message: WorkerToMain) =>
      onMessage(slot, message)
    );
    slot.worker.on('error', (error) => onWorkerError(slot, error));
    slot.worker.on('exit', (code) =>
      failSlot(
        slot,
        new Error(`[wyw-in-js] Transform pool worker exited with code ${code}`)
      )
    );
    slots.push(slot);
    log(
      'started worker %d/%d with %d parse cache entries',
      slots.length,
      maxWorkers,
      entries
    );
    return slot;
  };

  const workersLimitThroughput = (leastBusy: Slot): boolean => {
    if (!measuresUtilization) {
      return leastBusy.jobs.size >= JOBS_PER_WORKER_BEFORE_SCALING;
    }

    const now = performance.now();
    if (now - lastScaleCheckAt < SCALE_WINDOW_MS) {
      return false;
    }
    lastScaleCheckAt = now;

    const bundlerCurrent = performance.eventLoopUtilization();
    const bundler = performance.eventLoopUtilization(
      bundlerCurrent,
      bundlerBaseline
    );
    bundlerBaseline = bundlerCurrent;

    let saturated = bundler.utilization < BUNDLER_IDLE_UTILIZATION;
    for (const slot of slots) {
      const current = slot.worker.performance.eventLoopUtilization();
      const previous = utilizationBaselines.get(slot);
      const { utilization } = slot.worker.performance.eventLoopUtilization(
        current,
        previous
      );
      utilizationBaselines.set(slot, current);
      if (utilization < SATURATED_UTILIZATION) {
        saturated = false;
      }
    }
    return saturated;
  };

  const pickSlot = (): Slot => {
    const leastBusy = slots.reduce<Slot | null>(
      (best, slot) => (!best || slot.jobs.size < best.jobs.size ? slot : best),
      null
    );
    if (!leastBusy) {
      return spawn();
    }
    if (
      slots.length < maxWorkers &&
      leastBusy.jobs.size > 0 &&
      workersLimitThroughput(leastBusy)
    ) {
      return spawn();
    }
    return leastBusy;
  };

  const dispatch = (job: Job) => {
    const slot = pickSlot();
    nextJobId += 1;
    const id = nextJobId;
    slot.jobs.set(id, job);
    if (slot.jobs.size === 1) {
      slot.worker.ref();
    }
    slot.worker.postMessage({ ...job.request, id } satisfies MainToWorker);
  };
  redispatch = dispatch;

  return {
    dispose: async () => {
      disposed = true;
      const running = slots.splice(0);
      await Promise.all(
        running.map(async (slot) => {
          slot.worker.removeAllListeners('exit');
          await slot.worker.terminate();
          failSlot(slot, new Error('[wyw-in-js] Transform pool was disposed'));
        })
      );
    },
    transform: (options, code, emitWarning) => {
      if (disposed) {
        return Promise.reject(
          new Error('[wyw-in-js] Transform pool was disposed')
        );
      }

      return new Promise<Result>((resolve, reject) => {
        dispatch({
          emitWarning,
          reject,
          request: { code, options, type: 'transform' },
          resolve,
        });
      });
    },
  };
};
