// bin/do-it.mjs: the Node version is checked before anything else loads, so an old Node gets
// a plain message instead of a syntax error from a module it can't parse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'bin', 'do-it.mjs');
const run = (args, options = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20_000, ...options });

// Loads the real entry file in a process that reports a different Node version.
function asNode(version) {
  const code = `Object.defineProperty(process, 'versions', { value: { ...process.versions, node: ${JSON.stringify(version)} } });
await import(${JSON.stringify(pathToFileURL(entry).href)});`;
  return run(['--input-type=module', '-e', code]);
}

test('an old Node gets one plain message with the download link, and exits 1 without loading the CLI', () => {
  for (const version of ['8.17.0', '16.20.2', '18.20.4', '20.11.1', '21.7.3']) {
    const result = asNode(version);
    assert.equal(result.status, 1, version);
    assert.equal(result.stderr, `Do-It needs Node 22 or newer (you have ${version}).\nInstall a current Node.js from https://nodejs.org/en/download, then run this again.\n`, version);
    assert.equal(result.stdout, '', version);
  }
});

test('this Node gets past the check and reaches the real command', () => {
  // An unknown command makes the CLI print its usage and exit 1, whatever else is set up.
  const result = run([entry, 'frobnicate']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Usage: do-it \[start \| setup /);
  assert.doesNotMatch(result.stderr, /needs Node/);
});

test('the entry file stays parseable by an old Node: no static imports, no top-level await, no newer syntax', () => {
  const source = readFileSync(entry, 'utf8').replace(/^#!.*\n/, '').replace(/^\s*\/\/.*$/gm, ''); // code only: the comments explain the rules in words
  assert.doesNotMatch(source, /^\s*import\s/m); // static imports are hoisted and parsed before the check runs
  assert.doesNotMatch(source, /\bawait\b/);
  assert.doesNotMatch(source, /=>|\?\.|\?\?|\bconst\b|\blet\b|`/);
  assert.match(source, /import\('\.\.\/src\/main\.mjs'\)/);
});

test('package.json points the do-it command at the guard and ships it with the real CLI', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.bin['do-it'], 'bin/do-it.mjs');
  assert.ok(pkg.files.includes('bin/') && pkg.files.includes('src/'));
  assert.equal(pkg.engines.node, '>=22');
  assert.ok(existsSync(path.join(root, 'src', 'main.mjs')));
  if (process.platform !== 'win32') assert.ok((statSync(entry).mode & 0o111) !== 0, 'bin/do-it.mjs keeps its executable bit');
});
