import { appendFile, truncate } from 'node:fs/promises';

export const fileAdapter = filename => ({
  write: bytes => appendFile(filename, bytes),
  truncate: offset => truncate(filename, offset),
});
