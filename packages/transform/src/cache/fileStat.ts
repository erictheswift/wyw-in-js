import type { Stats } from 'node:fs';

export interface FileStat {
  mtimeMs: number;
  fingerprint: string | null;
}

// A write cannot preserve ctime, so a complete fingerprint proves the bytes
// unchanged. Partial stats (mocks, exotic filesystems) fall back to reading.
export const toFileStat = (stats: Stats): FileStat => ({
  mtimeMs: stats.mtimeMs,
  fingerprint:
    Number.isFinite(stats.ctimeMs) &&
    Number.isFinite(stats.size) &&
    Number.isFinite(stats.ino)
      ? `${stats.mtimeMs}\0${stats.ctimeMs}\0${stats.size}\0${stats.ino}`
      : null,
});

export const isFileStatUnchanged = (
  current: FileStat,
  cached: FileStat | undefined
): boolean =>
  cached !== undefined &&
  current.mtimeMs === cached.mtimeMs &&
  (cached.fingerprint === null || current.fingerprint === cached.fingerprint);
