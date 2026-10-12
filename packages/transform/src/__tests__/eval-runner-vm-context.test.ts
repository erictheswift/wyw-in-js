import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  createHarness,
  loadResult,
  stopHarness,
} from './__utils__/eval-runner-harness';

// Module hooks that make `import('happy-dom')` fail inside the runner, as it
// does in a build-time runtime that cannot load the package.
const blockHappyDomHooks = [
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier === 'happy-dom') {",
  '    const error = new Error("Cannot find package \'happy-dom\'");',
  "    error.code = 'ERR_MODULE_NOT_FOUND';",
  '    throw error;',
  '  }',
  '  return nextResolve(specifier, context);',
  '}',
].join('\n');

const toDataUrl = (code: string) =>
  `data:text/javascript,${encodeURIComponent(code)}`;

const blockHappyDom = toDataUrl(
  [
    "import { register } from 'node:module';",
    `register(${JSON.stringify(toDataUrl(blockHappyDomHooks))});`,
  ].join('\n')
);

describe('eval runner VM context', () => {
  it('continues without DOM emulation when happy-dom cannot be imported', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-runner-vm-context-'));
    const entry = join(root, 'entry.js');
    writeFileSync(entry, '');
    const harness = createHarness(root, {
      nodeArgs: ['--import', blockHappyDom],
    });

    try {
      await harness.send({
        type: 'INIT',
        id: 'init',
        payload: {
          debugEvalFiles: false,
          entrypoint: entry,
          evalOptions: {
            errors: 'strict',
            extensions: ['.js'],
            globals: {},
            require: 'warn-and-run',
            root,
          },
          features: { happyDOM: true },
          reuseModules: false,
          sessionId: 1,
        },
      });
      const init = await harness.take(
        (message) => message.type === 'INIT_ACK' && message.id === 'init',
        10_000
      );
      expect(init.error).toBeUndefined();

      await harness.send({ type: 'EVAL', id: 'eval', payload: { id: entry } });
      const load = await harness.take(
        (message) => message.type === 'LOAD' && message.payload?.id === entry
      );
      await harness.send(
        loadResult(
          load,
          entry,
          [
            'export const __wywPreval = {',
            '  value: () => [typeof document, typeof window].join(","),',
            '};',
          ].join('\n'),
          'entry',
          ['__wywPreval']
        )
      );
      const result = await harness.take(
        (message) => message.type === 'EVAL_RESULT' && message.id === 'eval'
      );

      expect(result.error).toBeUndefined();
      expect(
        (result.payload?.values as Record<string, { value: unknown }>).value
          .value
      ).toBe('undefined,object');

      const warning = harness.getStderr();
      expect(warning).toContain('features.happyDOM');
      expect(warning).toContain('"happy-dom" could not be loaded');
      expect(warning).toContain('features: { happyDOM: false }');
    } finally {
      await stopHarness(harness.child);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
