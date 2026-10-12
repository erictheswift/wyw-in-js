---
'@wyw-in-js/esbuild': patch
'@wyw-in-js/rollup': patch
'@wyw-in-js/vite': patch
---

Rebuild a file in watch mode when a module its styles are evaluated from changes. Imports that are only needed to compute styles at build time are removed from the transformed code, so the bundler did not know about them: Rollup watch, esbuild watch and `vite build --watch` kept the old CSS after such a module was edited. The plugins now register the resolved files of these dependencies, including the modules reached through them, as watched files (`this.addWatchFile` in Rollup and Vite, `watchFiles` in esbuild). Modules inside `node_modules` are not watched. The Vite dev server is unchanged: it already handles these edits through hot updates.
