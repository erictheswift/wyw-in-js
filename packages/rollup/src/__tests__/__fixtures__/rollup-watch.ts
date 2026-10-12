// Watches src/index.js of the working directory with the wyw-in-js plugin,
// applies the given file edits one per rebuild and prints, for every build,
// the CSS modules in the graph and the files Rollup re-transforms the entry
// for. The watch test runs it in its own process: `jest.mock` in bun is
// process-wide, so the transform mock of other test files in this package
// would otherwise reach the plugin.
import { writeFileSync } from 'fs';
import path from 'path';

import { watch } from 'rollup';
import type { RollupBuild, RollupWatcherEvent } from 'rollup';

import wywInJS from '../../index';

type Edit = { content: string; file: string };

type Build = { css: string[]; transformDependencies: string[] };

// Lets the watcher take its first snapshot of newly watched files.
const SETTLE_MS = 300;
const REBUILD_TIMEOUT_MS = 10_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const describeBuild = (result: RollupBuild, entry: string): Build => {
  const modules = result.cache?.modules ?? [];

  return {
    // The capture plugin turns CSS modules into JS, Rollup keeps the CSS
    // returned by the wyw-in-js `load` hook as the original code.
    css: modules
      .filter((module) => module.id.endsWith('.css'))
      .map((module) => module.originalCode),
    transformDependencies:
      modules.find((module) => module.id === entry)?.transformDependencies ??
      [],
  };
};

const run = async () => {
  const edits: Edit[] = JSON.parse(process.argv[2] ?? '[]');
  const root = process.cwd();
  const entry = path.join(root, 'src', 'index.js');
  const builds: Build[] = [];
  let notify: ((event: RollupWatcherEvent) => void) | undefined;

  const watcher = watch({
    input: entry,
    external: ['test-css-processor'],
    output: { dir: path.join(root, 'dist'), format: 'esm' },
    plugins: [
      wywInJS({ configFile: path.join(root, 'wyw-in-js.config.cjs') }),
      {
        name: 'capture-css',
        transform(_code, id) {
          return id.endsWith('.css') ? { code: 'export {};', map: null } : null;
        },
      },
    ],
    watch: {
      chokidar: { interval: 50, usePolling: true },
      skipWrite: true,
    },
  });

  const nextBuild = () =>
    new Promise<RollupWatcherEvent | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), REBUILD_TIMEOUT_MS);
      notify = (event) => {
        clearTimeout(timer);
        resolve(event);
      };
    });

  watcher.on('event', (event) => {
    if (event.code === 'BUNDLE_END' || event.code === 'ERROR') {
      notify?.(event);
    }
  });

  let pending = nextBuild();
  try {
    for (let index = 0; index <= edits.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      const event = await pending;
      if (!event) {
        process.stdout.write(JSON.stringify({ builds, timedOut: true }));
        return;
      }

      if (event.code === 'ERROR') {
        throw event.error;
      }

      if (event.code === 'BUNDLE_END') {
        builds.push(describeBuild(event.result, entry));
        // eslint-disable-next-line no-await-in-loop
        await event.result.close();
      }

      const edit = edits[index];
      if (edit) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(SETTLE_MS);
        pending = nextBuild();
        writeFileSync(path.join(root, edit.file), edit.content);
      }
    }

    process.stdout.write(JSON.stringify({ builds, timedOut: false }));
  } finally {
    await watcher.close();
  }
};

run().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 1;
});
