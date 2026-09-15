---
'@wyw-in-js/transform': patch
---

Avoid repeated shared-cache recovery for static-analysis dependencies and ignored assets while retaining strict graph checks for executable JavaScript. Keep loaded source separate from filesystem freshness evidence and invalidate every affected consumer after a shared dependency changes.

Preserve supersede errors and retries across analysis, action creation, and evaluation runner callbacks. Prevent same-instance reentrant module evaluation from deadlocking. Bound retries caused by other cache owners to 100, with owned and total counts on convergence errors.
