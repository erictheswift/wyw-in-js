import path from 'node:path';

import { logger } from '@wyw-in-js/shared';

import { buildDirectBarrelProxy } from '../eval/directBarrelProxy';
import { oxcShaker } from '../shaker';
import type { Services } from '../transform/types';

const processorFile = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const servicesFor = (code: string) =>
  ({
    loadAndParseFn: () => ({
      code,
      evalConfig: {},
      evaluator: oxcShaker,
    }),
    log: logger,
    options: {
      pluginOptions: {
        extensions: ['.ts'],
        rules: [{ action: oxcShaker }],
        tagResolver: (source: string, tag: string) =>
          source === 'test-css-processor' && tag === 'css'
            ? processorFile
            : null,
      },
    },
  }) as unknown as Services;

const proxyOf = (code: string, only: string[]) =>
  buildDirectBarrelProxy(servicesFor(code), '/project/A.ts', only);

const styledReexport = [
  "import { css } from 'test-css-processor';",
  "import { accent } from './theme';",
  "export { accent as tone } from './theme';",
  'export const style = css`background: ${accent};`;',
].join('\n');

describe('buildDirectBarrelProxy', () => {
  it('stands for a barrel without code of its own', () => {
    const proxy = proxyOf(
      [
        "export { accent } from './theme';",
        "export { other } from './other';",
      ].join('\n'),
      ['__wywPreval', 'accent']
    );

    expect(proxy?.code).toBe('export { accent } from "./theme";\n');
    expect(proxy?.only).toEqual(['__wywPreval', 'accent']);
  });

  it('is not built for a module with styles of its own when the load asks for __wywPreval', () => {
    expect(proxyOf(styledReexport, ['__wywPreval', 'tone'])).toBeNull();
  });

  it('stands for the re-exported names of a module with exports of its own', () => {
    const proxy = proxyOf(styledReexport, ['tone']);

    expect(proxy?.code).toBe('export { accent as tone } from "./theme";\n');
    expect(proxy?.only).toEqual(['tone']);
  });

  it('stands for the re-exported names of a module with exports but no styles of its own when the load asks for __wywPreval', () => {
    const proxy = proxyOf(
      [
        "export { accent } from './theme';",
        "export const version = '1.0.0';",
      ].join('\n'),
      ['__wywPreval', 'accent']
    );

    expect(proxy?.code).toBe('export { accent } from "./theme";\n');
    expect(proxy?.only).toEqual(['__wywPreval', 'accent']);
  });

  it('is not built for a request without re-exported names', () => {
    expect(
      proxyOf(
        [
          "import { css } from 'test-css-processor';",
          "export { accent } from './theme';",
          'export const style = css`color: red;`;',
        ].join('\n'),
        ['__wywPreval']
      )
    ).toBeNull();
  });
});
