---
'@wyw-in-js/transform': patch
---

Run the CommonJS emit of the transform stage only when its output is read. The stage converted every transformed root and dependency to CommonJS, but only the in-process `Module` evaluator reads that code; transforms that evaluate through the eval broker prepare their own code and never needed it. `Entrypoint.transformedCode` returns the same code as before, computed on first access. `EvaluatedEntrypoint.transformResultCode` of a cached entrypoint is now `null` unless that code was read before the module was evaluated; read `Entrypoint.transformedCode` instead. Both members are deprecated.
