---
'@wyw-in-js/babel-preset': patch
---

Parse the transformed code with the parser options of the file being compiled. The transformed code keeps JSX and TypeScript syntax, but the preset parsed it without any syntax plugins, so a JSX or TypeScript file with a WyW tag failed with errors such as "Support for the experimental syntax 'jsx' isn't currently enabled", even when `@babel/preset-react` or `@babel/preset-typescript` was configured.
