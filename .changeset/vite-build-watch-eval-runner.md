---
'@wyw-in-js/vite': patch
---

Stop the eval runner after every build of `vite build --watch`, not only after the first one. A runner started by a rebuild kept running after the watcher was closed and kept the Node.js process alive.
