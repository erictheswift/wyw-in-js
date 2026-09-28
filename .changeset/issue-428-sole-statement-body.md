---
'@wyw-in-js/transform': patch
---

Keep the module parseable when dangerous-code removal drops a statement that is the sole body of `if`/`else`/`for`/`while`/`do`/labeled statement. The body is replaced with an empty block instead of nothing, so `if (cond)\n  idle = (cb) => requestIdleCallback(cb);` no longer becomes `if (cond)` followed by the next declaration (#428). The empty block leaves the owning statement effect-free, so the shaker drops it unless its head still mutates a live binding (`while (a--) {}` stays, `while (a) {}` goes).
