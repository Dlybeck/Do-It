#!/usr/bin/env node
// The `do-it` command. This file only checks the Node version, then loads the real command
// (src/main.mjs). It must stay free of static imports, top-level await and syntax newer than
// the oldest Node that can run an .mjs file, because ES imports are hoisted: anything imported
// here would be parsed before the check ran, and an old Node would stop with a raw syntax error
// instead of saying what to do.
var NEEDED = 22;
var have = process.versions.node;
if (Number(have.split('.')[0]) < NEEDED) {
  console.error('Do-It needs Node ' + NEEDED + ' or newer (you have ' + have + ').\nInstall a current Node.js from https://nodejs.org/en/download, then run this again.');
  process.exit(1);
}
import('../src/main.mjs').catch(function (error) {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
