---
'@wyw-in-js/webpack-loader': patch
---

Pass extracted CSS source maps through the loader callback when composing CSS loader pipelines. This avoids duplicate inline maps and intermediate source contents when composing extracted stylesheets, while keeping each CSS request tied to its source map. Raw asset modules retain inline CSS maps for source navigation.
