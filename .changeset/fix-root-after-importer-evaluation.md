---
'@wyw-in-js/transform': patch
---

Fix `AbortError: superseded` when a styled module is transformed after a module that imports it has already evaluated all of its exports through the same cache. Bundler plugins usually transform the importer first, so such a module failed to build, on the first build and after every edit, when its importer read every value it exports and at least one of them needs evaluation: for example `import { accent, style } from './A'` where `A` exports `accent = (() => 'blue')()` next to a `css` class, an object of classes with a computed member, a tokens object with a computed property, or a namespace import that reads every export. The module now reuses that evaluation and extracts its CSS.
