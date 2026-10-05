import type { PartialOptions } from '../transform/helpers/loadWywOptions';
import type { Options, Result } from '../types';

export type TransformPoolJobOptions = Pick<
  Options,
  | 'filename'
  | 'inputSourceMap'
  | 'keepComments'
  | 'outputFilename'
  | 'prefixer'
  | 'root'
> & {
  preprocessor?: 'none' | 'stylis';
};

export type TransformPoolWorkerData = {
  asyncResolveKey: string;
  parseCacheEntries: number;
  pluginOptions: PartialOptions;
};

export type SerializedError = {
  code?: string;
  message: string;
  name: string;
  stack?: string;
};

export type MainToWorker =
  | {
      code: string;
      id: number;
      options: TransformPoolJobOptions;
      type: 'transform';
    }
  | { entries: number; type: 'parse-cache-limit' }
  | { requestId: number; result: string | null; type: 'resolved' }
  | { error: SerializedError; requestId: number; type: 'resolve-failed' };

export type WorkerToMain =
  | {
      importer: string;
      requestId: number;
      stack: string[];
      type: 'resolve';
      what: string;
    }
  | { id: number; message: string; type: 'warning' }
  | { id: number; result: Result; type: 'result' }
  | { error: SerializedError; id: number; type: 'error' };

export const serializeError = (error: unknown): SerializedError => {
  if (!(error instanceof Error)) {
    return { message: String(error), name: 'Error' };
  }

  const { code } = error as { code?: unknown };
  return {
    code: typeof code === 'string' ? code : undefined,
    message: error.message,
    name: error.name,
    stack: error.stack,
  };
};

export const deserializeError = ({
  code,
  message,
  name,
  stack,
}: SerializedError): Error =>
  Object.assign(new Error(message), {
    name,
    stack,
    ...(code === undefined ? {} : { code }),
  });
