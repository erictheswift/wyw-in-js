import path from 'path';

/** The part of the transform `Result` that lists its dependencies. */
type TransformDependencies = {
  dependencies?: string[];
  dependencyResolutions?: { resolved: string; source: string }[];
};

type ResolveId = (specifier: string) => Promise<string | null | undefined>;

const nodeModulesPattern = /[\\/]node_modules[\\/]/;

// Vite ids may carry a `?query`; virtual ids are not files.
const toWatchFile = (id: string | null | undefined): string | null => {
  if (!id || id.startsWith('\0')) return null;

  const [file] = id.split('?', 1);
  return path.isAbsolute(file) && !nodeModulesPattern.test(file) ? file : null;
};

/**
 * Files outside `node_modules` whose edits must re-transform the module
 * `result` belongs to. `Result.dependencies` lists the module's own imports
 * by specifier, with the resolution the transform used in
 * `dependencyResolutions`, and the modules behind them by absolute path.
 * Specifiers without a recorded resolution go through `resolveId`.
 */
export const getWatchFiles = async (
  result: TransformDependencies,
  resolveId: ResolveId
): Promise<string[]> => {
  const resolutions = new Map(
    (result.dependencyResolutions ?? []).map(({ resolved, source }) => [
      source,
      resolved,
    ])
  );

  const files = await Promise.all(
    (result.dependencies ?? []).map(async (dependency) => {
      if (path.isAbsolute(dependency)) return toWatchFile(dependency);

      const resolved = resolutions.get(dependency);
      if (resolved !== undefined) return toWatchFile(resolved);

      try {
        return toWatchFile(await resolveId(dependency));
      } catch {
        return null;
      }
    })
  );

  return [...new Set(files.filter((file): file is string => file !== null))];
};
