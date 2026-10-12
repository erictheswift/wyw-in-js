// Runs `vite build --watch` for src/index.js of the working directory with the
// wyw-in-js plugin (and the given plugin options), applies the given file
// edits one per rebuild and prints
// the emitted CSS of every build. The build-watch test runs it in its own
// process: `jest.mock` in bun is process-wide, so the vite and transform mocks
// of other test files in this package would otherwise reach the plugin.
import { writeFileSync } from 'fs';
import path from 'path';

import { build } from 'vite';
import type { Plugin, Rollup } from 'vite';

import wywInJS from '../../index';

type Edit = { content: string; file: string };

// Lets the watcher take its first snapshot of newly watched files.
const SETTLE_MS = 300;
const REBUILD_TIMEOUT_MS = 10_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const run = async () => {
  const edits: Edit[] = JSON.parse(process.argv[2] ?? '[]');
  const options = JSON.parse(process.argv[3] ?? '{}');
  const root = process.cwd();
  const builds: string[] = [];
  let css = '';
  let notify: ((event: Rollup.RollupWatcherEvent) => void) | undefined;

  const captureCss: Plugin = {
    name: 'capture-css',
    generateBundle(_options, bundle) {
      css = Object.values(bundle)
        .map((item) =>
          item.type === 'asset' && item.fileName.endsWith('.css')
            ? String(item.source)
            : ''
        )
        .join('');
    },
  };

  const watcher = (await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      wywInJS({
        configFile: path.join(root, 'wyw-in-js.config.cjs'),
        ...options,
      }),
      captureCss,
    ],
    build: {
      minify: false,
      outDir: path.join(root, 'dist'),
      rollupOptions: { input: path.join(root, 'src', 'index.js') },
      watch: { chokidar: { interval: 50, usePolling: true } },
    },
  })) as Rollup.RollupWatcher;

  const nextBuild = () =>
    new Promise<Rollup.RollupWatcherEvent | null>((resolve) => {
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
        builds.push(css.replace(/\s/g, ''));
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
