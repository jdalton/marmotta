import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { compressionTriple } from '../dist/compress.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const assets = process.env.MARMOTTA_COMPRESSION_DIR
  ?? fileURLToPath(new URL('../dist/compression/', import.meta.url));
const exe = process.platform === 'win32' ? '.exe' : '';
function haveNativeAssets() {
  let triple;
  try {
    triple = compressionTriple();
  } catch (error) {
    if (process.env.MARMOTTA_REQUIRE_COMPRESSION_TESTS === '1') throw error;
    return false;
  }
  return existsSync(join(assets, `producer-${triple}${exe}`))
    && existsSync(join(assets, `stub-${triple}.node`));
}
const haveAssets = haveNativeAssets();
const skip = !haveAssets && process.env.MARMOTTA_REQUIRE_COMPRESSION_TESTS !== '1'
  && 'run npm run build:compression to build the native helpers';

const addon = `#include <node_api.h>

NAPI_MODULE_INIT() {
  napi_value answer;
  if (napi_create_int32(env, 42, &answer) != napi_ok) return 0;
  return answer;
}
`;

function runNode(args, env) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', env });
}

test('compressed build loads from one file and survives a failed rebuild', { skip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta compressed-'));
  const output = join(directory, 'answer.node');
  const source = join(directory, 'answer.cpp');
  const env = {
    ...process.env,
    MARMOTTA_HOME: join(directory, 'toolchain'),
    MARMOTTA_NATIVE_CACHE: join(directory, 'cache'),
  };
  const run = (...args) => runNode([cli, args[0], '-C', directory, ...args.slice(1)], env);
  const load = () => runNode(['-e', `console.log(require(process.argv[1]));`, output], env);

  try {
    await writeFile(source, addon);
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({
      name: 'answer',
      sources: ['answer.cpp'],
      linkerFlags: ['-nostdlib++'],
    }));
    const compressed = run('build', '--compress');
    assert.equal(compressed.status, 0, compressed.stderr || compressed.stdout);
    const carrier = await readFile(output);
    assert.ok(carrier.includes(Buffer.from('NAPCSECT')), 'the output carries the embedded payload');

    for (let attempt = 0; attempt < 2; attempt++) {
      const loaded = load();
      assert.equal(loaded.status, 0, loaded.stderr);
      assert.equal(loaded.stdout.trim(), '42');
    }

    const workers = runNode(['-e', `
      const assert = require('node:assert/strict');
      const { Worker } = require('node:worker_threads');
      const source = "const { parentPort, workerData } = require('node:worker_threads');"
        + "parentPort.postMessage(require(workerData));";
      for (let index = 0; index < 2; index++) {
        const worker = new Worker(source, { eval: true, workerData: process.argv[1] });
        worker.on('message', (value) => assert.equal(value, 42));
        worker.on('exit', (code) => assert.equal(code, 0));
      }
    `, output], env);
    assert.equal(workers.status, 0, workers.stderr);

    const rebuilt = run('rebuild', '--compress');
    assert.equal(rebuilt.status, 0, rebuilt.stderr || rebuilt.stdout);
    const previous = await readFile(output);
    await writeFile(source, 'extern "C" int exported_but_not_an_addon(void) { return 42; }\n');
    const rejected = run('rebuild', '--compress');
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /napi_register_module_v1/);
    assert.deepEqual(await readFile(output), previous);
    assert.equal(load().stdout.trim(), '42');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('compressed addon keeps the payload Node-API version', {
  skip: skip || (Number(process.versions.napi) < 10 && 'Node-API 10 is unavailable'),
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-compressed-version-'));
  const env = {
    ...process.env,
    MARMOTTA_HOME: join(directory, 'toolchain'),
    MARMOTTA_NATIVE_CACHE: join(directory, 'cache'),
  };
  try {
    // Node-API 10 allows references to numbers. Node-API 8 rejects them even on the same host.
    await writeFile(join(directory, 'answer.c'), `#define NAPI_VERSION 10
#include <node_api.h>

NAPI_MODULE_INIT() {
  napi_value answer;
  napi_ref reference;
  if (napi_create_int32(env, 42, &answer) != napi_ok) return 0;
  if (napi_create_reference(env, answer, 1, &reference) != napi_ok) {
    napi_throw_error(env, 0, "the addon needs Node-API 10");
    return 0;
  }
  napi_delete_reference(env, reference);
  return answer;
}
`);
    await writeFile(join(directory, 'marmotta.config.json'), JSON.stringify({
      name: 'answer',
      sources: ['answer.c'],
    }));

    for (const [output, flags] of [['raw', []], ['packed', ['--compress']]]) {
      const built = runNode([cli, 'build', '-C', directory, '-o', output, ...flags], env);
      assert.equal(built.status, 0, built.stderr || built.stdout);
      const filename = join(directory, output, 'answer.node');
      const loaded = runNode(['-e', 'console.log(require(process.argv[1]))', filename], env);
      assert.equal(loaded.status, 0, loaded.stderr || loaded.signal);
      assert.equal(loaded.stdout.trim(), '42');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
