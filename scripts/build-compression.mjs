#!/usr/bin/env node
// Build the host-side compressor and Node-API loader stubs used by `napi build --compress`.
// Rust is an optional build-time tool; it is never part of npm install.
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const native = join(root, 'native');
const output = resolve(process.env.MARMOTTA_COMPRESSION_DIR ?? join(root, 'dist', 'compression'));
const targets = [
  'aarch64-apple-darwin', 'x86_64-apple-darwin',
  'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-musl', 'x86_64-unknown-linux-musl',
  'aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc',
];

const toolchain = process.env.MARMOTTA_RUST_TOOLCHAIN ?? 'nightly-2026-09-26';
function runCargo(args, { env = process.env, encoding } = {}) {
  const result = spawnSync('rustup', ['run', toolchain, 'cargo', ...args], { cwd: native, env, stdio: encoding ? 'pipe' : 'inherit', encoding });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`rustup run ${toolchain} cargo ${args.join(' ')} failed (${result.status ?? 'signal'})`);
  return result;
}

function rustHost() {
  const result = spawnSync('rustup', ['run', toolchain, 'rustc', '-vV'], { encoding: 'utf8' });
  if (result.error) throw new Error(`Could not start rustup: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Could not determine Rust host target; install ${toolchain} with rustup. ${result.stderr?.trim() ?? ''}`);
  return result.stdout.match(/^host: (.+)$/m)?.[1];
}

function libraryPath(target) {
  if (target.endsWith('-apple-darwin')) return 'libnapi_native_addon_stub.dylib';
  if (target.endsWith('-pc-windows-msvc')) return 'napi_native_addon_stub.dll';
  return 'libnapi_native_addon_stub.so';
}

await mkdir(output, { recursive: true });
const selectedHost = rustHost();
if (!selectedHost) throw new Error('Could not determine Rust host target.');
const producerTarget = process.argv.find((arg) => arg.startsWith('--producer-target='))?.slice('--producer-target='.length) ?? selectedHost;
if (!targets.includes(producerTarget)) throw new Error(`Unsupported producer target ${producerTarget}; supported: ${targets.join(', ')}`);
const requestedStubs = process.argv.find((arg) => arg.startsWith('--stubs='))?.slice('--stubs='.length);
const producerOnly = process.argv.includes('--producer-only');
const stubOnly = process.argv.includes('--stub-only');
if (producerOnly && stubOnly) throw new Error('Choose either --producer-only or --stub-only.');
const selectedTargets = producerOnly ? [] : requestedStubs === 'host' ? [selectedHost] : requestedStubs?.split(',') ?? [producerTarget];
for (const target of selectedTargets) {
  if (!targets.includes(target)) throw new Error(`Unsupported stub target ${target}; supported: ${targets.join(', ')}`);
}

// The producer runs on the build host and is embedded in matching standalone builds. Keep the
// workspace's normal release profile (including static musl defaults) for this executable.
const metadata = runCargo(['metadata', '--locked', '--no-deps', '--format-version', '1'], { encoding: 'utf8' });
const targetDirectory = JSON.parse(metadata.stdout).target_directory;
if (!stubOnly) {
  // The musl producer is intentionally static. On a glibc host, use musl-gcc to link it; a native
  // musl host already has the right default linker and should not be forced through musl-gcc.
  const producerArgs = ['build', '--locked', '--release', '-p', 'napi-compress'];
  if (producerTarget !== selectedHost) producerArgs.push('--target', producerTarget);
  const producerEnv = { ...process.env };
  if (producerTarget.endsWith('-unknown-linux-musl') && producerTarget !== selectedHost) {
    const linkerKey = `CARGO_TARGET_${producerTarget.toUpperCase().replaceAll('-', '_')}_LINKER`;
    producerEnv[linkerKey] = 'musl-gcc';
    producerEnv[`CC_${producerTarget}`] = 'musl-gcc';
    producerEnv[`CC_${producerTarget.replaceAll('-', '_')}`] = 'musl-gcc';
  }
  runCargo(producerArgs, { env: producerEnv });
  const hostSuffix = producerTarget.includes('windows') ? '.exe' : '';
  const producerBuildDir = producerTarget === selectedHost ? 'release' : join(producerTarget, 'release');
  await copyFile(join(targetDirectory, producerBuildDir, `napi-compress${hostSuffix}`), join(output, `producer-${producerTarget}${hostSuffix}`));
}

// The addon contains code derived from napi-rs. Include its upstream notice and MIT license in
// the npm package alongside the prebuilt assets.
await copyFile(join(native, 'UPSTREAM-NOTICE.md'), join(output, 'UPSTREAM-NOTICE.md'));
await copyFile(join(native, 'UPSTREAM-LICENSE'), join(output, 'UPSTREAM-LICENSE'));

for (const target of selectedTargets) {
  // Cross targets must be installed with rustup. Cargo's target-specific linker requirements are
  // intentionally left to the caller/CI image, so native target failures remain easy to diagnose.
  let env = { ...process.env };
  if (target.endsWith('-apple-darwin')) env.RUSTFLAGS = [env.RUSTFLAGS, '-C link-arg=-Wl,-headerpad,0x1000'].filter(Boolean).join(' ');
  if (target.endsWith('-unknown-linux-musl')) {
    env.RUSTFLAGS = [env.RUSTFLAGS, '-C target-feature=-crt-static'].filter(Boolean).join(' ');
    if (target !== selectedHost) {
      const linkerKey = `CARGO_TARGET_${target.toUpperCase().replaceAll('-', '_')}_LINKER`;
      env[linkerKey] = 'musl-gcc';
      env[`CC_${target}`] = 'musl-gcc';
      env[`CC_${target.replaceAll('-', '_')}`] = 'musl-gcc';
    }
  }
  runCargo(['build', '--locked', '--profile', 'addon-min', '-p', 'napi-native-addon-stub', '--target', target], { env });
  const source = join(targetDirectory, target, 'addon-min', libraryPath(target));
  await copyFile(source, join(output, `stub-${target}.node`));
}

// Remove Cargo's transient files from the published collection and give callers a useful inventory.
const entries = (await readdir(output)).sort();
console.log(`Compression assets in ${output}:\n${entries.map((entry) => `  ${entry}`).join('\n')}`);
