import type { KnownBug, FreshnessScenario } from '../types';

import { fromCache, runtimeValue, staticValue, styled } from './sources';

const barrelRecovery = (
  description: string,
  intended: KnownBug['intended'] = {}
): KnownBug => ({
  impact: 'performance',
  description:
    `${description} Каждый повторный transform корня, чей импорт ` +
    'переписан на runtime-лист barrel, запускает fail-closed recovery ' +
    '(сброс всего кэша) и полный пересчёт — даже холостой, сразу после ' +
    'холодной сборки. Вероятная причина: eval исполняет barrel.ts, который ' +
    'никогда не публикуется как подготовленный модуль, и его граф считается ' +
    'неизвестным. Со статическими листьями recovery нет ' +
    '(barrel-static-leaf-edit).',
  intended: { reset: 'none', ...intended },
});

const accentOverPalette = [
  "import { base } from './palette';",
  '',
  'export const accent = (() => `${base}-accent`)();',
  '',
].join('\n');

/**
 * A styled module that re-exports `accent` from theme.ts with `reexport` and
 * uses it in its own style: a barrel for the re-exported name only.
 */
const reexportingStyled = (reexport: string): string =>
  styled(
    ["import { accent } from './theme';", reexport],
    'background: ${accent};'
  );

/** page.ts reads a value and the class of A.ts in its own style. */
const pageOverA = (value: string): string =>
  styled(
    [`import { ${value}, style as a } from './A';`],
    `color: \${${value}}; & .\${a} { color: \${${value}}; }`
  );

const reexportProject = (reexport: string, value = 'accent') => ({
  'page.ts': pageOverA(value),
  'A.ts': reexportingStyled(reexport),
  'theme.ts': accentOverPalette,
  'palette.ts': runtimeValue('base', 'blue'),
});

const pageCss = (color: string): string[] => [
  `color:${color}-accent;`,
  `color:${color}-accent;`,
];

const moduleCss = (color: string): string[] => [`background:${color}-accent;`];

const rootCopyNarrowed = (description: string): KnownBug => ({
  impact: 'performance',
  description:
    `${description} A.ts готовится заново, хотя ничего не менялось: eval ` +
    'публикует вычисленную копию A.ts с экспортом accent, который в той же ' +
    'eval-сессии запрашивал page.ts, и evaluatedOnly копии ' +
    'перезаписывается списком сериализованных экспортов без __wywPreval. ' +
    'Следующий transform A.ts такую копию переиспользовать не может.',
  intended: fromCache,
});

/** Barrel rewrites: named re-exports, `export *`, static re-export chains. */
export const barrelScenarios: FreshnessScenario[] = [
  {
    id: 'barrel-leaf-edit',
    title: 'правка листа barrel (именованные реэкспорты)',
    refs: ['#268', '#271'],
    files: {
      'root.ts': styled(
        ["import { primary } from './barrel';"],
        'color: ${primary};'
      ),
      'barrel.ts': [
        "export { primary } from './primary';",
        "export { secondary } from './secondary';",
        '',
      ].join('\n'),
      'primary.ts': runtimeValue('primary', 'blue'),
      'secondary.ts': runtimeValue('secondary', 'gray'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'импорт переписан на лист; barrel.ts исполняется, но не готовится',
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['primary.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'primary.ts', 'root.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['primary.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'primary.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery(
          'Холостой transform до любых правок.',
          fromCache
        ),
      },
      { do: 'write', files: { 'primary.ts': runtimeValue('primary', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['primary.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'primary.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Правка используемого листа.'),
      },
      {
        do: 'write',
        files: { 'secondary.ts': runtimeValue('secondary', 'black') },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['primary.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'primary.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery(
          'Правка неиспользуемого листа: вывод корня от неё не зависит.',
          fromCache
        ),
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['primary.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'primary.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Холостой transform.', fromCache),
      },
    ],
  },
  {
    id: 'barrel-retarget',
    title: 'barrel перенаправляет реэкспорт на другой лист',
    refs: ['#268'],
    files: {
      'root.ts': styled(
        ["import { tone } from './barrel';"],
        'color: ${tone};'
      ),
      'barrel.ts': "export { tone } from './light';\n",
      'light.ts': runtimeValue('tone', 'white'),
      'dark.ts': runtimeValue('tone', 'black'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:white;'] },
          prepared: ['light.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'light.ts', 'root.ts'],
        },
      },
      {
        do: 'write',
        files: { 'barrel.ts': "export { tone } from './dark';\n" },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: '#268: barrel — зависимость инвалидации переписанного импорта',
        expect: {
          css: { 'root.ts': ['color:black;'] },
          prepared: ['dark.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'dark.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Правка самого barrel.'),
      },
      { do: 'write', files: { 'light.ts': runtimeValue('tone', 'ivory') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:black;'] },
          prepared: ['dark.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'dark.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery(
          'Правка листа, на который barrel больше не ссылается.',
          fromCache
        ),
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:black;'] },
          prepared: ['dark.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'dark.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Холостой transform.', fromCache),
      },
    ],
  },
  {
    id: 'export-star-leaf-edit',
    title: 'правка листа за `export *`, дважды',
    refs: ['#271'],
    files: {
      'root.ts': styled(
        ["import { tone } from './barrel';"],
        'color: ${tone};'
      ),
      'barrel.ts': "export * from './leaf';\n",
      'leaf.ts': runtimeValue('tone', 'white'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:white;'] },
          prepared: ['leaf.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'leaf.ts', 'root.ts'],
        },
      },
      { do: 'write', files: { 'leaf.ts': runtimeValue('tone', 'black') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: '#271: кэш barrel-анализа зависит от листьев за `export *`',
        expect: {
          css: { 'root.ts': ['color:black;'] },
          prepared: ['leaf.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'leaf.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Правка листа за `export *`.'),
      },
      { do: 'write', files: { 'leaf.ts': runtimeValue('tone', 'gray') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:gray;'] },
          prepared: ['leaf.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'leaf.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Вторая правка листа за `export *`.'),
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:gray;'] },
          prepared: ['leaf.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'leaf.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Холостой transform.', fromCache),
      },
    ],
  },
  {
    id: 'barrel-static-leaf-edit',
    title: 'правка статического листа barrel',
    refs: ['#268', '#271'],
    files: {
      'root.ts': styled(
        ["import { primary } from './barrel';"],
        'color: ${primary};'
      ),
      'barrel.ts': [
        "export { primary } from './primary';",
        "export { secondary } from './secondary';",
        '',
      ].join('\n'),
      'primary.ts': staticValue('primary', 'blue'),
      'secondary.ts': staticValue('secondary', 'gray'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'значение разрешается статически через barrel',
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['root.ts'],
          evaluated: [],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fromCache },
      },
      { do: 'write', files: { 'primary.ts': staticValue('primary', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['root.ts'],
          evaluated: [],
        },
      },
      {
        do: 'write',
        files: { 'secondary.ts': staticValue('secondary', 'black') },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'правка неиспользуемого листа не пересчитывает корень',
        expect: { css: { 'root.ts': ['color:red;'] }, ...fromCache },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:red;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'static-reexport-chain',
    title: 'статическая цепочка реэкспортов (analysis roots)',
    refs: ['#423'],
    files: {
      'root.ts': styled(
        ["import { tokenA } from './tokens';"],
        'color: ${tokenA};'
      ),
      'tokens.ts': "export { red as tokenA } from './sub';\n",
      'sub.ts': "export { red } from './helpers';\n",
      'helpers.ts': staticValue('red', 'red'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'значение разрешается статически: eval-раннер не нужен',
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['root.ts'],
          evaluated: [],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: '#423: звенья цепочки — известный граф, а не recovery',
        expect: { css: { 'root.ts': ['color:red;'] }, ...fromCache },
      },
      { do: 'write', files: { 'helpers.ts': staticValue('red', 'blue') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['root.ts'],
          evaluated: [],
        },
      },
      { do: 'write', files: { 'helpers.ts': staticValue('red', 'green') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:green;'] },
          prepared: ['root.ts'],
          evaluated: [],
        },
      },
    ],
  },
  {
    id: 'reexported-value-used-importer-first',
    title:
      'модуль реэкспортирует значение и сам его использует; импортёр первым',
    refs: [],
    files: reexportProject("export { accent } from './theme';"),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        note:
          'загрузка A.ts из eval page.ts несёт __wywPreval: A.ts готовится ' +
          'из своего кода, прокси реэкспорта не строится',
        expect: {
          css: { 'page.ts': pageCss('blue') },
          prepared: ['page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }],
        note: 'eval A.ts берёт модуль, подготовленный для page.ts',
        expect: {
          css: { 'A.ts': moduleCss('blue') },
          prepared: ['A.ts'],
          evaluated: [],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }, { file: 'A.ts' }],
        expect: {
          css: { 'page.ts': pageCss('blue'), 'A.ts': moduleCss('blue') },
          ...fromCache,
        },
      },
      { do: 'write', files: { 'palette.ts': runtimeValue('base', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': pageCss('red') },
          prepared: ['page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }],
        expect: {
          css: { 'A.ts': moduleCss('red') },
          prepared: ['A.ts'],
          evaluated: ['A.ts'],
        },
        knownBug: {
          impact: 'performance',
          description:
            'Код A.ts снова отправляется в eval-раннер, хотя eval page.ts ' +
            'на предыдущем шаге уже исполнил свежий A.ts. Готовя A.ts для ' +
            'eval page.ts, брокер заново создаёт entrypoint A.ts; проверка ' +
            'свежести находит устаревшей его публикацию до правки и снова ' +
            'помечает A.ts инвалидированным, уже после того как эта загрузка ' +
            'забрала прежнюю пометку. Загрузка корня A.ts забирает оставшуюся ' +
            'пометку и сбрасывает модуль в раннере.',
          intended: { evaluated: [] },
        },
      },
    ],
  },
  {
    id: 'reexported-value-renamed-importer-first',
    title: 'то же с переименованием при реэкспорте',
    refs: [],
    files: reexportProject("export { accent as tone } from './theme';", 'tone'),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': pageCss('blue') },
          prepared: ['page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }],
        expect: {
          css: { 'A.ts': moduleCss('blue') },
          prepared: ['A.ts'],
          evaluated: [],
        },
      },
    ],
  },
  {
    id: 'reexported-value-used-concurrently',
    title: 'то же, импортёр и модуль параллельно',
    refs: [],
    files: reexportProject("export { accent } from './theme';"),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }, { file: 'A.ts' }],
        expect: {
          css: { 'page.ts': pageCss('blue'), 'A.ts': moduleCss('blue') },
          prepared: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
      { do: 'write', files: { 'palette.ts': runtimeValue('base', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }, { file: 'A.ts' }],
        expect: {
          css: { 'page.ts': pageCss('red'), 'A.ts': moduleCss('red') },
          prepared: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
    ],
  },
  {
    id: 'reexported-star-value-used-importer-first',
    title: 'то же через `export *`, импортёр первым',
    refs: [],
    files: reexportProject("export * from './theme';"),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        note: 'за `export *` прокси не строится: A.ts исполняется целиком',
        expect: {
          css: { 'page.ts': pageCss('blue') },
          prepared: ['page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }],
        expect: {
          css: { 'A.ts': moduleCss('blue') },
          prepared: ['A.ts'],
          evaluated: [],
        },
      },
    ],
  },
  {
    id: 'reexported-value-used-module-first',
    title: 'модуль реэкспортирует значение и сам его использует; модуль первым',
    refs: [],
    files: reexportProject("export { accent } from './theme';"),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }],
        expect: {
          css: { 'A.ts': moduleCss('blue') },
          prepared: ['A.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'palette.ts', 'theme.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': pageCss('blue') },
          prepared: ['page.ts'],
          evaluated: ['A.ts', 'page.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }],
        note: 'повторный transform A.ts в той же eval-сессии, что и page.ts',
        expect: {
          css: { 'A.ts': moduleCss('blue') },
          prepared: ['A.ts'],
          evaluated: [],
        },
        knownBug: rootCopyNarrowed('Холостой transform.'),
      },
    ],
  },
];
