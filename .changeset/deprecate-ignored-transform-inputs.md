---
'@wyw-in-js/transform': minor
'@wyw-in-js/shared': minor
---

Deprecate more public API that the transform pipeline ignores or no longer needs. Everything keeps working in 2.x and is removed in 3.0.

- The `asyncResolve`, `evalBroker` and `evalCacheKey` fields of the first argument of `transform()`. `transform()` ignores them: pass the resolver as its third argument. The `loadAndParseFn` field is deprecated together with the `LoadAndParseFn` type.
- The `TransformCacheCollection` methods `beginUnknownGraphRecovery`, `beginSupersedeStormRecovery` and `createGraphTraversalToken`, which the pipeline does not call.
- The `useWeakRefInEval` feature flag. It affects only the deprecated `Module` evaluator; in 3.0 the flag will have no effect.
