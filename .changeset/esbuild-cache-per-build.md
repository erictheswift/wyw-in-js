---
'@wyw-in-js/esbuild': patch
---

Let one plugin instance serve several builds at the same time. All builds of a plugin instance shared one transform cache and one eval runner, and the end of any build stopped that runner, so a build that was still evaluating failed with `Eval broker has been disposed`. Each `esbuild.build()` call or `esbuild.context()` now gets its own cache and runner; the rebuilds of one context keep reusing the cache. Separate `esbuild.build()` calls no longer reuse each other's cached results.
