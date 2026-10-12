import { logger } from '@wyw-in-js/shared';

import { buildDirectBarrelProxy } from '../eval/directBarrelProxy';
import { oxcShaker } from '../shaker';
import type { Services } from '../transform/types';

const servicesFor = (code: string) =>
  ({
    loadAndParseFn: () => ({
      code,
      evalConfig: {},
      evaluator: oxcShaker,
    }),
    log: logger,
  }) as unknown as Services;

const proxyOf = (code: string, only: string[]) =>
  buildDirectBarrelProxy(servicesFor(code), '/project/A.ts', only);

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

  it('covers only the re-exported names of a module with exports of its own', () => {
    const proxy = proxyOf(
      [
        "import { css } from 'test-css-processor';",
        "import { accent } from './theme';",
        "export { accent as tone } from './theme';",
        'export const style = css`background: ${accent};`;',
      ].join('\n'),
      ['__wywPreval', 'side-effect', 'tone']
    );

    expect(proxy?.code).toBe('export { accent as tone } from "./theme";\n');
    expect(proxy?.only).toEqual(['tone']);
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
