import { css } from '@wyw-in-js/template-tag-syntax';

import { accent } from './theme';

// Re-exports `accent` and uses it in its own style. The entry reads only
// `accent` at build time, so this module is evaluated for that value alone
// before it is transformed itself.
export { accent } from './theme';

export const button = css`
  background: ${accent};
`;
