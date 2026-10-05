import fs from 'fs';
import os from 'os';
import path from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { createTransformPool } from '../pool/pool';
import { transform } from '../transform';

const processorFile = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const createProject = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-pool-'));
  const configFile = path.join(root, 'wyw-in-js.config.cjs');
  fs.writeFileSync(
    configFile,
    dedent`
      module.exports = {
        tagResolver: (source, tag) =>
          source === 'test-css-processor' && tag === 'css'
            ? ${JSON.stringify(processorFile)}
            : null,
      };
    `
  );
  fs.writeFileSync(
    path.join(root, 'tokens.ts'),
    `export const colors = { red: 'red', blue: 'blue' };`
  );

  const files = ['red', 'blue'].map((color) => {
    const filename = path.join(root, `${color}.ts`);
    fs.writeFileSync(
      filename,
      dedent`
        import { css } from 'test-css-processor';
        import { colors } from './tokens';

        export const className = css\`
          color: \${colors.${color}};
        \`;
      `
    );
    return filename;
  });

  const resolutions: Array<{ root: string | undefined; what: string }> = [];
  const asyncResolve = async (
    what: string,
    importer: string,
    stack: string[]
  ) => {
    resolutions.push({ root: stack.at(-1), what });
    if (what === 'test-css-processor') {
      return processorFile;
    }

    return path.resolve(path.dirname(importer), `${what}.ts`);
  };

  return {
    asyncResolve,
    configFile,
    files,
    resolutions,
    root,
    cleanup: () => fs.rmSync(root, { force: true, recursive: true }),
  };
};

describe('createTransformPool', () => {
  it('produces the same result as an in-process transform', async () => {
    const project = createProject();
    const pool = createTransformPool({
      asyncResolve: project.asyncResolve,
      pluginOptions: { configFile: project.configFile },
      workers: 2,
    });

    try {
      const pooled = await Promise.all(
        project.files.map((filename) =>
          pool.transform(
            { filename, root: project.root },
            fs.readFileSync(filename, 'utf8')
          )
        )
      );
      const inProcess = await Promise.all(
        project.files.map((filename) =>
          transform(
            {
              cache: new TransformCacheCollection(),
              options: {
                filename,
                root: project.root,
                pluginOptions: { configFile: project.configFile },
              },
            },
            fs.readFileSync(filename, 'utf8'),
            project.asyncResolve
          )
        )
      );

      expect(pooled.map(({ cssText }) => cssText)).toEqual(
        inProcess.map(({ cssText }) => cssText)
      );
      expect(pooled.map(({ code }) => code)).toEqual(
        inProcess.map(({ code }) => code)
      );
      expect(pooled[0].cssText).toContain('color:red');
      expect(pooled[1].cssText).toContain('color:blue');
    } finally {
      await pool.dispose();
      project.cleanup();
    }
  });

  it('routes resolutions to the main thread with the root file on the stack', async () => {
    const project = createProject();
    const pool = createTransformPool({
      asyncResolve: project.asyncResolve,
      pluginOptions: { configFile: project.configFile },
      workers: 1,
    });

    try {
      const [filename] = project.files;
      await pool.transform(
        { filename, root: project.root },
        fs.readFileSync(filename, 'utf8')
      );

      expect(project.resolutions).toContainEqual({
        root: filename,
        what: './tokens',
      });
    } finally {
      await pool.dispose();
      project.cleanup();
    }
  });

  it('picks up a changed dependency in the long-lived worker cache', async () => {
    const project = createProject();
    const pool = createTransformPool({
      asyncResolve: project.asyncResolve,
      pluginOptions: { configFile: project.configFile },
      workers: 1,
    });

    try {
      const [filename] = project.files;
      const run = () =>
        pool.transform(
          { filename, root: project.root },
          fs.readFileSync(filename, 'utf8')
        );

      expect((await run()).cssText).toContain('color:red');

      fs.writeFileSync(
        path.join(project.root, 'tokens.ts'),
        `export const colors = { red: 'green', blue: 'blue' };`
      );

      expect((await run()).cssText).toContain('color:green');
    } finally {
      await pool.dispose();
      project.cleanup();
    }
  });

  it('completes transforms when a worker heap limit is too small', async () => {
    const project = createProject();
    const pool = createTransformPool({
      asyncResolve: project.asyncResolve,
      pluginOptions: { configFile: project.configFile },
      workerHeapLimitMb: 8,
      workers: 1,
    });

    try {
      const [filename] = project.files;
      const result = await pool.transform(
        { filename, root: project.root },
        fs.readFileSync(filename, 'utf8')
      );

      expect(result.cssText).toContain('color:red');
    } finally {
      await pool.dispose();
      project.cleanup();
    }
  });

  it('rejects function-valued plugin options', () => {
    expect(() =>
      createTransformPool({
        asyncResolve: async () => null,
        pluginOptions: { tagResolver: () => null },
      })
    ).toThrow(
      '[wyw-in-js] pluginOptions.tagResolver is a function, which cannot be sent to transform pool workers.'
    );
  });

  it('rejects transforms after dispose', async () => {
    const pool = createTransformPool({ asyncResolve: async () => null });
    await pool.dispose();

    await expect(
      pool.transform({ filename: '/virtual/file.ts' }, 'export {};')
    ).rejects.toThrow('[wyw-in-js] Transform pool was disposed');
  });
});
