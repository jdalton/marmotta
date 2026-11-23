import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isStandalone, readEmbeddedAsset } from './standalone.js';
import { PlatformNotSupportedError, InternalError } from './errors.js';
import { run } from './toolchain.js';

function hostLinuxAbi(): 'gnu' | 'musl' {
  // Node reports glibc when present; its absence on Linux indicates a musl runtime. Bun's
  // process.report may be missing, so use ldd's available runtime information there.
  try {
    const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
    if (report?.header?.glibcVersionRuntime) return 'gnu';
    if (report?.header && 'glibcVersionRuntime' in report.header) return 'musl';
  } catch {
    // Some alternate runtimes only provide a placeholder for process.report.
  }
  const ldd = spawnSync('ldd', ['--version'], { encoding: 'utf8' });
  if (/musl/i.test(`${ldd.stdout ?? ''}\n${ldd.stderr ?? ''}`)) return 'musl';
  if (ldd.status === 0) return 'gnu';
  throw new PlatformNotSupportedError('unable to detect Linux libc (GNU or musl) for the compression producer');
}

function normalizeTarget(target?: string): { rust: string; exe: string } {
  if (target?.toLowerCase() === 'native') target = undefined;
  const candidate = target ?? (process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : '');
  const arch = /^(aarch64|arm64)(?:-|$)/i.test(candidate) ? 'aarch64'
    : /^(x86_64|x64)(?:-|$)/i.test(candidate) ? 'x86_64' : undefined;
  if (!arch) throw new PlatformNotSupportedError(`compression target ${target ?? `${process.platform}/${process.arch}`}`);

  if (target === undefined) {
    if (process.platform === 'darwin') return { rust: `${arch}-apple-darwin`, exe: '' };
    if (process.platform === 'linux') return { rust: `${arch}-unknown-linux-${hostLinuxAbi()}`, exe: '' };
    if (process.platform === 'win32') return { rust: `${arch}-pc-windows-msvc`, exe: '.exe' };
    throw new PlatformNotSupportedError(`${process.platform}/${process.arch}`);
  }

  const lower = target.toLowerCase();
  const parts = lower.split('-');
  if (parts.some((part) => /^macos(?:\.|$)/.test(part)) || parts.includes('darwin')) {
    return { rust: `${arch}-apple-darwin`, exe: '' };
  }
  if (parts.some((part) => /^windows(?:\.|$)/.test(part))) {
    const abi = parts.slice(parts.findIndex((part) => /^windows(?:\.|$)/.test(part)) + 1)
      .find((part) => part !== 'unknown' && part !== 'pc');
    if (abi && !/^(msvc|gnu)(?:\.|$)/.test(abi)) throw new PlatformNotSupportedError(`compression target ${target}`);
    return { rust: `${arch}-pc-windows-msvc`, exe: '.exe' };
  }
  const linuxIndex = parts.findIndex((part) => /^linux(?:\.|$)/.test(part));
  if (linuxIndex >= 0) {
    const abiPart = parts.slice(linuxIndex + 1).find((part) => part !== 'unknown');
    if (abiPart && !/^(gnu|musl)(?:\.|$)/.test(abiPart)) {
      throw new PlatformNotSupportedError(`compression target ${target}`);
    }
    const abi = abiPart?.startsWith('musl') ? 'musl' : 'gnu';
    return { rust: `${arch}-unknown-linux-${abi}`, exe: '' };
  }
  throw new PlatformNotSupportedError(`compression target ${target}`);
}

async function assetPath(name: string, executable: boolean): Promise<{ path: string; cleanup?: () => Promise<void> }> {
  const override = process.env.MARMOTTA_COMPRESSION_DIR;
  if (override || !isStandalone()) {
    const path = override
      ? join(resolve(override), name)
      : join(dirname(fileURLToPath(import.meta.url)), 'compression', name);
    try {
      await access(path);
    } catch (cause) {
      const source = override ? 'MARMOTTA_COMPRESSION_DIR' : 'the Marmotta package';
      throw new InternalError(`Compression asset ${name} is missing from ${source} (${path}). Set MARMOTTA_COMPRESSION_DIR to a directory containing the required producer and stub assets.`, { cause });
    }
    if (!executable || process.platform === 'win32' || ((await stat(path)).mode & 0o111) !== 0) return { path };
    // Package artifact downloads may strip Unix execute bits. Run a private copy so we never
    // mutate the installed package or a user-provided asset directory.
    return writeAssetTemp(name, await readFile(path), 0o700);
  }
  const content = await readEmbeddedAsset(name);
  if (!content) throw new InternalError(`Compression asset ${name} is missing from this standalone build. Reinstall Marmotta or use an npm package.`);
  return writeAssetTemp(name, content, executable ? 0o700 : 0o600);
}

async function writeAssetTemp(name: string, content: Buffer, mode: number): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'marmotta-compress-'));
  const path = join(directory, name);
  try {
    await writeFile(path, content, { mode });
    if (mode === 0o700) await chmod(path, mode);
    return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function compressAddon(rawPath: string, outputPath: string, target?: string, dependencyDir?: string): Promise<void> {
  const host = normalizeTarget();
  const addonTarget = target === undefined ? host : normalizeTarget(target);
  const producerName = `producer-${host.rust}${host.exe}`;
  const stubName = `stub-${addonTarget.rust}.node`;
  const producer = await assetPath(producerName, true);
  try {
    const stub = await assetPath(stubName, false);
    try {
      const args = [stub.path, rawPath, outputPath];
      if (dependencyDir) args.push('--dependency-dir', dependencyDir);
      await run(producer.path, args);
    } finally {
      await stub.cleanup?.();
    }
  } finally {
    await producer.cleanup?.();
  }
}

export function compressionTriple(target?: string): string {
  return normalizeTarget(target).rust;
}
