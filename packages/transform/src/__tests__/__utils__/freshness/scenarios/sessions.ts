import type { FreshnessScenario, KnownBug } from '../types';

import { fromCache, rootWithDep, runtimeValue, styled } from './sources';

const fullRecompute = {
  prepared: ['dep.ts', 'root.ts'],
  evaluated: ['dep.ts', 'root.ts'],
};

const loaderRootRecompute: KnownBug = {
  impact: 'performance',
  description:
    'После правки зависимости, которая приходит из loadDependencyCode, ' +
    'следующий повторный transform корня ещё раз готовит и исполняет ' +
    'корень (сама зависимость из кэша): новый код загрузчика сообщается ' +
    'вторым изменением уже после того, как корень учёл правку диска.',
  intended: fromCache,
};

/**
 * page.ts → card.ts → image.ts. The bundler hands the image.ts root code that
 * a loader before wyw changed (like Storybook's react-docgen-loader), so its
 * own CSS shows `-loaded`; its exports keep their values.
 */
const loaderChain = (size: string): Record<string, string> => ({
  'image.ts': styled(
    [`export const size = (() => '${size}')();`],
    'width: ${size}; outline: none-disk;'
  ),
  'card.ts': styled(
    [
      "import { size } from './image';",
      '',
      'export const cardSize = (() => `${size}-card`)();',
    ],
    'height: ${cardSize};'
  ),
  'page.ts': styled(
    ["import { cardSize } from './card';"],
    'min-height: ${cardSize};'
  ),
});

const chainRecompute = {
  prepared: ['card.ts', 'image.ts', 'page.ts'],
  evaluated: ['card.ts', 'image.ts', 'page.ts'],
};

/**
 * page.ts and page2.ts read `accent` and the class of A.ts, which re-exports
 * `accent` from theme.ts and uses it in its own style. palette.ts carries a
 * `-disk` marker in a comment only: a loader that rewrites it changes the
 * code, not the value.
 */
const reexportOverLoadedPalette = (base: string): Record<string, string> => ({
  'palette.ts': `${runtimeValue('base', base)}// none-disk\n`,
  'theme.ts': [
    "import { base } from './palette';",
    '',
    'export const accent = (() => `${base}-accent`)();',
    '',
  ].join('\n'),
  'A.ts': styled(
    ["import { accent } from './theme';", "export { accent } from './theme';"],
    'background: ${accent};'
  ),
  'page.ts': styled(
    ["import { accent, style as a } from './A';"],
    'color: ${accent}; & .${a} { margin: 0; }'
  ),
  'page2.ts': styled(
    ["import { accent, style as a } from './A';"],
    'border-color: ${accent}; & .${a} { margin: 0; }'
  ),
});

/**
 * What a transform runs with: the cache salt (resolver, options), the
 * bundler-provided code of roots and dependencies, request variants and
 * explicit invalidation.
 */
export const sessionScenarios: FreshnessScenario[] = [
  {
    id: 'salt-resolver-key',
    title: 'смена соли: другой ключ резолвера и возврат к прежнему',
    refs: ['#234'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    sessions: { other: { resolverKey: 'freshness-other' } },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fullRecompute },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'other' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          ...fullRecompute,
          reset: 'salt',
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'кэш одной соли за раз: возврат к прежней снова всё сбрасывает',
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          ...fullRecompute,
          reset: 'salt',
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'salt-plugin-options',
    title: 'смена соли: опции плагина',
    refs: ['#234'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    sessions: {
      sameOptionsNewObject: { freshPluginOptionsPerCall: true },
      noHappyDom: { pluginOptions: { features: { happyDOM: false } } },
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fullRecompute },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'sameOptionsNewObject' }],
        note: 'соль считается по содержимому опций, а не по identity объекта',
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fromCache },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'noHappyDom' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          ...fullRecompute,
          reset: 'salt',
        },
      },
    ],
  },
  {
    id: 'resolver-identity-salt',
    title: 'без asyncResolveKey соль зависит от identity функции резолвера',
    refs: ['#234'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    sessions: {
      default: { resolverKey: null, freshResolverPerCall: true },
      stableResolver: { resolverKey: null },
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fullRecompute },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'контракт API: новая функция резолвера без ключа — новая соль',
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          ...fullRecompute,
          reset: 'salt',
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'stableResolver' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          ...fullRecompute,
          reset: 'salt',
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'stableResolver' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'loaded-dependency-code',
    title: 'код зависимости из loadDependencyCode отличается от диска',
    refs: ['#234', '#238'],
    files: {
      'root.ts': rootWithDep,
      'dep.ts': runtimeValue('color', 'blue-disk'),
    },
    sessions: {
      default: { loader: { key: 'loader', files: { 'dep.ts': 'loaded' } } },
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'исполняется код загрузчика, а не байты с диска',
        expect: {
          css: { 'root.ts': ['color:blue-loaded;'] },
          ...fullRecompute,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note:
          '#234, #422: расхождение «загрузчик ≠ диск» не инвалидирует ' +
          'dep.ts и не пересчитывает корень',
        expect: { css: { 'root.ts': ['color:blue-loaded;'] }, ...fromCache },
      },
      { do: 'write', files: { 'dep.ts': runtimeValue('color', 'red-disk') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red-loaded;'] },
          ...fullRecompute,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red-loaded;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
        knownBug: loaderRootRecompute,
      },
    ],
  },
  {
    id: 'loaded-then-disk',
    title: 'зависимость сначала из загрузчика, затем с диска и обратно',
    refs: ['#423', '#427'],
    files: {
      'root.ts': rootWithDep,
      'dep.ts': runtimeValue('color', 'blue-disk'),
    },
    sessions: {
      default: { loader: { key: 'loader', files: { 'dep.ts': 'loaded' } } },
      disk: { loader: { key: 'loader', files: { 'dep.ts': 'none' } } },
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue-loaded;'] },
          ...fullRecompute,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'disk' }],
        note:
          '#427: байты на диске не менялись — повторно используется ' +
          'прежний код загрузчика',
        expect: { css: { 'root.ts': ['color:blue-loaded;'] }, ...fromCache },
      },
      { do: 'write', files: { 'dep.ts': runtimeValue('color', 'red-disk') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'disk' }],
        expect: {
          css: { 'root.ts': ['color:red-disk;'] },
          ...fullRecompute,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note:
          'ревизия на диске та же: корень из кэша, загрузчик не ' +
          'спрашивается, остаётся исполненный дисковый код (одинаковый ' +
          'loadDependencyCodeKey обещает одинаковую семантику)',
        expect: { css: { 'root.ts': ['color:red-disk;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'root-loaded-source',
    title: 'код корня от бандлера отличается от диска',
    refs: ['#234', '#427'],
    files: {
      'root.ts': styled(
        ["import { color } from './dep';"],
        'color: ${color}; outline: none-disk;'
      ),
      'dep.ts': runtimeValue('color', 'blue'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts', source: 'loaded' }],
        expect: {
          css: { 'root.ts': ['color:blue;outline:none-loaded;'] },
          ...fullRecompute,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', source: 'loaded' }],
        expect: {
          css: { 'root.ts': ['color:blue;outline:none-loaded;'] },
          ...fromCache,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue;outline:none-disk;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', source: 'loaded' }],
        expect: {
          css: { 'root.ts': ['color:blue;outline:none-loaded;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
      },
    ],
  },
  {
    id: 'loaded-root-after-importers',
    title:
      'корень с кодом загрузчика (≠ диск) после импортёров, читавших его с диска',
    refs: ['#422', '#427'],
    files: loaderChain('16px'),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': ['min-height:16px-card;'] },
          ...chainRecompute,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'image.ts', source: 'loaded' }],
        note: 'корень исполняет код загрузчика, а не прочитанные с диска байты',
        expect: {
          css: { 'image.ts': ['width:16px;outline:none-loaded;'] },
          prepared: ['image.ts'],
          evaluated: ['image.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        note:
          '#422: диск не менялся, код загрузчика — не новость для ' +
          'импортёров: ни каскада вытеснений, ни recovery',
        expect: { css: { 'page.ts': ['min-height:16px-card;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'loaded-root-importer-in-flight',
    title: 'корень с кодом загрузчика (≠ диск), пока импортёр-корень ждёт eval',
    refs: ['#422', '#427'],
    files: loaderChain('16px'),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': ['min-height:16px-card;'] },
          ...chainRecompute,
        },
      },
      {
        do: 'start',
        id: 'card',
        call: { file: 'card.ts' },
        hold: { at: 'eval' },
      },
      {
        do: 'transform',
        calls: [{ file: 'image.ts', source: 'loaded' }],
        note: 'включает подготовку удержанного корня card.ts',
        expect: {
          css: { 'image.ts': ['width:16px;outline:none-loaded;'] },
          prepared: ['card.ts', 'image.ts'],
          evaluated: ['image.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        note:
          '#422: проверка свежести page.ts не вытесняет удержанный корень ' +
          'card.ts',
        expect: { css: { 'page.ts': ['min-height:16px-card;'] }, ...fromCache },
      },
      { do: 'release', id: 'card' },
      {
        do: 'join',
        note: 'корень card.ts не перезапускается',
        expect: { css: { card: ['height:16px-card;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'loaded-root-after-edit',
    title:
      'правка файла между чтением с диска импортёром и приходом корня ' +
      'с кодом загрузчика',
    refs: ['#422', '#427'],
    files: loaderChain('16px'),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': ['min-height:16px-card;'] },
          ...chainRecompute,
        },
      },
      { do: 'write', files: { 'image.ts': loaderChain('20px')['image.ts'] } },
      {
        do: 'transform',
        calls: [{ file: 'image.ts', source: 'loaded' }],
        expect: {
          css: { 'image.ts': ['width:20px;outline:none-loaded;'] },
          prepared: ['image.ts'],
          evaluated: ['image.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        note:
          'диск уже не совпадает с тем, что прочли импортёры: правка ' +
          'доходит до них, хотя первой её увидела проверка корня',
        expect: {
          css: { 'page.ts': ['min-height:20px-card;'] },
          prepared: ['card.ts', 'page.ts'],
          evaluated: ['card.ts', 'page.ts'],
        },
      },
    ],
  },
  {
    id: 'loaded-root-after-edit-and-invalidation',
    title:
      'правка и invalidateForFile файла, его новые байты читает другой ' +
      'импортёр, затем корень с кодом загрузчика',
    refs: ['#422', '#427'],
    files: {
      ...loaderChain('16px'),
      'card2.ts': styled(
        ["import { size } from './image';"],
        'max-height: ${size};'
      ),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': ['min-height:16px-card;'] },
          ...chainRecompute,
        },
      },
      { do: 'write', files: { 'image.ts': loaderChain('20px')['image.ts'] } },
      { do: 'invalidate', files: ['image.ts'] },
      {
        do: 'transform',
        calls: [{ file: 'card2.ts' }],
        note: 'запоминает хеш новых байтов image.ts без версии изменения',
        expect: {
          css: { 'card2.ts': ['max-height:20px;'] },
          prepared: ['card2.ts', 'image.ts'],
          evaluated: ['card2.ts', 'image.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'image.ts', source: 'loaded' }],
        expect: {
          css: { 'image.ts': ['width:20px;outline:none-loaded;'] },
          prepared: ['image.ts'],
          evaluated: ['image.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        note:
          'диск совпадает с последним прочитанным, но page.ts и card.ts ' +
          'читали прежние байты: после invalidateForFile код загрузчика ' +
          'по-прежнему сообщается как изменение',
        expect: {
          css: { 'page.ts': ['min-height:20px-card;'] },
          prepared: ['card.ts', 'page.ts'],
          evaluated: ['card.ts', 'page.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'card.ts' }],
        expect: {
          css: { 'card.ts': ['height:20px-card;'] },
          prepared: ['card.ts'],
          evaluated: [],
        },
      },
    ],
  },
  {
    id: 'loaded-dependency-reexport-second-edit',
    title:
      'вторая правка транзитивной зависимости из loadDependencyCode за ' +
      'реэкспортом стилизованного модуля, между правками собран другой импортёр',
    refs: ['#263', '#422'],
    files: reexportOverLoadedPalette('blue'),
    sessions: {
      default: { loader: { key: 'loader', files: { 'palette.ts': 'loaded' } } },
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': ['color:blue-accent;', 'margin:0;'] },
          prepared: ['page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page2.ts' }],
        expect: {
          css: { 'page2.ts': ['border-color:blue-accent;', 'margin:0;'] },
          prepared: ['page2.ts'],
          evaluated: ['page2.ts'],
        },
      },
      {
        do: 'write',
        files: { 'palette.ts': reexportOverLoadedPalette('red')['palette.ts'] },
      },
      {
        do: 'transform',
        calls: [{ file: 'page2.ts' }],
        expect: {
          css: { 'page2.ts': ['border-color:red-accent;', 'margin:0;'] },
          prepared: ['page2.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page2.ts', 'palette.ts', 'theme.ts'],
          reset: 'recovery',
        },
        knownBug: {
          impact: 'performance',
          description:
            'Пересборка page2.ts после правки palette.ts запускает ' +
            'fail-closed recovery (сброс всего кэша). Так же и без ' +
            'загрузчика; причину в этой строке не разбирали.',
          intended: { reset: 'none' },
        },
      },
      {
        do: 'write',
        files: {
          'palette.ts': reexportOverLoadedPalette('green')['palette.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': ['color:red-accent;', 'margin:0;'] },
          prepared: ['page.ts'],
          evaluated: ['page.ts'],
        },
        knownBug: {
          impact: 'correctness',
          description:
            'Вторая правка транзитивной зависимости не доходит до page.ts, ' +
            'если первую видел только page2.ts: page.ts пересобирается, но ' +
            'palette.ts, theme.ts и A.ts заново в eval-раннер не попадают, ' +
            'и он берёт их значения после первой правки (red вместо green). ' +
            'Загрузчик, возвращающий байты с диска, и сборка без загрузчика ' +
            'устаревают здесь так же, в том числе до исправления #422. С ' +
            'кодом загрузчика, отличным от диска, до #422 строка была ' +
            'свежей: этот код сообщался как изменение palette.ts и вытеснял ' +
            'её импортёров.',
          intended: {
            css: { 'page.ts': ['color:green-accent;', 'margin:0;'] },
            evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
          },
        },
      },
    ],
  },
  {
    id: 'query-variants',
    title: 'варианты одного файла с ?query / #hash',
    refs: ['#234', '#278'],
    files: {
      'root.ts': styled(
        ["import { color } from './dep?inline';"],
        'color: ${color};'
      ),
      'dep.ts': runtimeValue('color', 'blue'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts?variant=a' }, { file: 'root.ts#b' }],
        note: 'каждый вариант — отдельный узел кэша',
        expect: {
          css: {
            'root.ts?variant=a': ['color:blue;'],
            'root.ts#b': ['color:blue;'],
          },
          prepared: ['dep.ts?inline', 'root.ts#b', 'root.ts?variant=a'],
          evaluated: ['dep.ts?inline', 'root.ts#b', 'root.ts?variant=a'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
      },
      { do: 'write', files: { 'dep.ts': runtimeValue('color', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts?variant=a' }, { file: 'root.ts#b' }],
        expect: {
          css: {
            'root.ts?variant=a': ['color:red;'],
            'root.ts#b': ['color:red;'],
          },
          prepared: ['dep.ts?inline', 'root.ts#b', 'root.ts?variant=a'],
          evaluated: ['dep.ts?inline', 'root.ts#b', 'root.ts?variant=a'],
          reset: 'recovery',
        },
        knownBug: {
          impact: 'performance',
          description:
            'Два варианта корня, параллельно пересобираемые после правки ' +
            'общей зависимости, запускают fail-closed recovery (сброс ' +
            'всего кэша).',
          intended: { reset: 'none' },
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
      },
    ],
  },
  {
    id: 'explicit-invalidate',
    title: 'явная инвалидация (invalidateForFile, как в Vite HMR)',
    refs: ['#411', '#423'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fullRecompute },
      },
      { do: 'invalidate', files: ['dep.ts'] },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'вытеснение без изменения содержимого не заставляет пересчитывать',
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fromCache },
      },
      {
        do: 'write',
        files: { 'dep.ts': runtimeValue('color', 'cyan') },
        mtime: 'preserve',
      },
      { do: 'invalidate', files: ['dep.ts', 'root.ts'] },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:cyan;'] }, ...fullRecompute },
      },
    ],
  },
];
