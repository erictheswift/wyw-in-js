// Appends component metadata to modules that export components, as
// Storybook's react-docgen-loader does, so wyw gets code that differs from
// the file on disk.
module.exports = function docgenLikeLoader(source) {
  const components = [
    ...source.matchAll(/export const ([A-Z][A-Za-z0-9]*) = \(/g),
  ].map((match) => match[1]);
  if (components.length === 0) {
    return source;
  }

  const metadata = components.map(
    (name) => `${name}.__docgenInfo = { displayName: ${JSON.stringify(name)} };`
  );
  return `${source}\n${metadata.join('\n')}\n`;
};
