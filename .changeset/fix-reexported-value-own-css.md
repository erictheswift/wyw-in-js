---
'@wyw-in-js/transform': patch
---

Fix missing CSS of a styled module that re-exports a value with `export { … } from` and also uses that value in its own styles, for example `export { accent } from './theme'` next to ``export const button = css`background: ${accent};` ``, also when the value is renamed, as in `export { accent as tone } from './theme'`, or is the default export, as in `export { default } from './theme'`. When a module that imports it was evaluated first through the same cache, which is the order bundler plugins usually use, the evaluation of the styled module itself reused the narrow re-export module built for that importer. The module then produced no CSS and no error, on the first build and on later rebuilds. Such a module is now evaluated from its own code.
