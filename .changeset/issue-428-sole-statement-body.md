---
'@wyw-in-js/transform': patch
---

Keep the module parseable when dangerous-code removal drops a statement that is the sole body of `if`/`else`/`for`/`while`/`do`/labeled statement. The statement is replaced with an empty block instead of nothing, so `if (cond)\n  idle = (cb) => requestIdleCallback(cb);` no longer becomes `if (cond)` followed by the next declaration (#428).
