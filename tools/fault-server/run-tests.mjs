// Entry point for `node --test <this directory>/`.
//
// Node 22+ treats a positional argument to --test as a file/glob, and running
// a directory resolves to its package.json "main". This file is that main: it
// loads every *.test.mjs below this directory so the directory form keeps
// working. The equivalent glob form needs no entry point:
//   node --test "<this directory>/**/*.test.mjs"
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here, {recursive: true})
  .filter(name => name.endsWith('.test.mjs') && !name.split(path.sep).includes('node_modules'))
  .sort();
if (files.length === 0) {
  throw new Error(`no *.test.mjs files found under ${here}`);
}
for (const name of files) {
  await import(pathToFileURL(path.join(here, name)).href);
}
