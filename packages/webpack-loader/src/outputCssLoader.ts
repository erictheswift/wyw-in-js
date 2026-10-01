import type webpack from 'webpack';

import type { ICache } from './cache';
import { decodeOutputCssPayload, getCacheInstance, toCacheKey } from './cache';

export default async function outputCssLoader(
  this: webpack.LoaderContext<{
    cacheProvider: string | ICache | undefined;
    cacheProviderToken?: string | undefined;
    outputCssPayload?: string | undefined;
  }>
) {
  this.async();
  const { cacheProvider, cacheProviderToken, outputCssPayload } =
    this.getOptions();

  try {
    // A serialized payload is tied to this exact module request. Prefer it to
    // runtime state, which may belong to a later compilation after a restart.
    // Transform dependencies stay on the cached parent module, so the payload
    // does not need to duplicate machine-specific absolute paths.
    if (outputCssPayload) {
      const payload = decodeOutputCssPayload(outputCssPayload);
      let { cssText } = payload;
      const moduleType = this._module?.type;
      if (
        payload.cssSourceMapText &&
        (moduleType === 'asset' || moduleType?.startsWith('asset/'))
      ) {
        // Asset modules emit the CSS bytes without consuming callback maps.
        // CSS loader pipelines compose the callback map instead.
        cssText += `/*# sourceMappingURL=data:application/json;base64,${Buffer.from(
          payload.cssSourceMapText
        ).toString('base64')}*/`;
      }
      this.callback(
        null,
        cssText,
        payload.cssSourceMapText
          ? JSON.parse(payload.cssSourceMapText)
          : undefined
      );
      return;
    }

    const cacheKey = toCacheKey(this.resourcePath);
    const cacheInstance = await getCacheInstance(
      cacheProvider,
      this._compiler,
      cacheProviderToken
    );
    const cachedCssText = await cacheInstance.get(cacheKey);

    if (cachedCssText) {
      const dependencies =
        (await cacheInstance.getDependencies?.(cacheKey)) ?? [];
      dependencies.forEach((dependency) => {
        this.addDependency(dependency);
      });

      this.callback(null, cachedCssText);
      return;
    }

    throw new Error(`CSS cache entry not found for ${this.resourcePath}`);
  } catch (err) {
    this.callback(err as Error);
  }
}
