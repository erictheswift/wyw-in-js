---
'@wyw-in-js/transform': minor
'@wyw-in-js/webpack-loader': minor
---

Add `createTransformPool()` to run whole-file transforms in worker threads, and a `parallel` option for `@wyw-in-js/webpack-loader` that uses it. Each worker keeps one long-lived transform cache, loads plugin options once, and sends resolutions back to the bundler's resolver with the import stack, so webpack still tracks dependencies through its own resolver. The pool starts with one worker and adds another only while all workers are busy and the bundler thread waits on them; the parsed-AST cache budget is split between running workers. Function-valued options must come from a config file (`configFile`), since they cannot be sent to a worker. Integrations without a compiler lifetime (for example Rspack parallel loaders) keep transforming in-process.
