---
'@wyw-in-js/processor-utils': patch
'@wyw-in-js/shared': patch
'@wyw-in-js/transform': patch
'@wyw-in-js/turbopack-loader': patch
'@wyw-in-js/webpack-loader': patch
---

Add file extensions to relative imports in the published type declarations. The packages are ES modules, so with `moduleResolution` set to `node16` or `nodenext` TypeScript could not resolve imports such as `./debug/fileReporter`: types re-exported from those modules were missing, or became `any` when `skipLibCheck` hid the errors. The declarations now import `./debug/fileReporter.js` and `./parallel/index.js`, like the runtime files do.
