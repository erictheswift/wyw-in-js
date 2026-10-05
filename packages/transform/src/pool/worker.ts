import { parentPort, workerData } from 'node:worker_threads';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import { setParseCacheLimit } from '../utils/parseOxc';

import type {
  MainToWorker,
  TransformPoolWorkerData,
  WorkerToMain,
} from './protocol';
import { deserializeError, serializeError } from './protocol';

const port = parentPort!;
const { asyncResolveKey, parseCacheEntries, pluginOptions } =
  workerData as TransformPoolWorkerData;

setParseCacheLimit(parseCacheEntries);

// One cache per worker for its whole lifetime, like the per-compiler cache of
// an in-process integration. `pluginOptions` keeps one identity so
// loadWywOptions resolves the config file once.
const cache = new TransformCacheCollection();

const post = (message: WorkerToMain) => port.postMessage(message);

let nextRequestId = 0;
const pendingResolves = new Map<
  number,
  { reject: (error: Error) => void; resolve: (result: string | null) => void }
>();

// A single resolver identity for every job: cached entrypoints keep the
// services of the transform that created them, so the main thread routes each
// request by its import stack, exactly as an in-process integration does.
const asyncResolve = (what: string, importer: string, stack: string[]) =>
  new Promise<string | null>((resolve, reject) => {
    nextRequestId += 1;
    const requestId = nextRequestId;
    pendingResolves.set(requestId, { reject, resolve });
    post({ importer, requestId, stack, type: 'resolve', what });
  });

const runTransform = ({
  code,
  id,
  options,
}: Extract<MainToWorker, { type: 'transform' }>) => {
  transform(
    {
      asyncResolveKey,
      cache,
      emitWarning: (message) => post({ id, message, type: 'warning' }),
      options: { ...options, pluginOptions },
    },
    code,
    asyncResolve
  ).then(
    (result) => post({ id, result, type: 'result' }),
    (error: unknown) =>
      post({ error: serializeError(error), id, type: 'error' })
  );
};

port.on('message', (message: MainToWorker) => {
  if (message.type === 'transform') {
    runTransform(message);
    return;
  }

  if (message.type === 'parse-cache-limit') {
    setParseCacheLimit(message.entries);
    return;
  }

  const pending = pendingResolves.get(message.requestId);
  pendingResolves.delete(message.requestId);
  if (!pending) {
    return;
  }

  if (message.type === 'resolved') {
    pending.resolve(message.result);
  } else {
    pending.reject(deserializeError(message.error));
  }
});
