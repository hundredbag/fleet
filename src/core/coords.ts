import type { McpServerSpec } from './types.js';

/**
 * A package coordinate extracted from an installed MCP server's spec, used to
 * match it against registry FeedItems. Only `high` confidence drives an
 * "update available" claim; everything else is "present, unmatched".
 */
export interface Coordinate {
  ecosystem: 'npm' | 'pypi' | 'other';
  id: string;
  version?: string;
  confidence: 'high' | 'low';
}

/**
 * Canonical key for matching a coordinate across sources + inventory. PyPI names
 * are PEP 503-normalized (runs of `._-` collapse to `-`) so `some_package` and
 * `some-package` match; npm keeps its scope. Case-insensitive.
 */
export function coordKey(ecosystem: string, id: string): string {
  const lo = id.toLowerCase();
  return `${ecosystem}:${ecosystem === 'pypi' ? lo.replace(/[-_.]+/g, '-') : lo}`;
}

type RunnerKind = 'npx' | 'uvx' | 'pipx';

const NPM_EXPLICIT_PACKAGE = new Set(['-p', '--package']);
const PYPI_EXPLICIT_PACKAGE = new Set(['--from']);
const PYPI_EXTRA_DEPENDENCY = new Set(['-w', '--with', '--with-editable', '--with-requirements']);
const NPM_VALUE_FLAGS = new Set(['--loglevel']);
const SOURCE_OVERRIDE_FLAGS = new Set([
  '-c',
  '--call',
  '--registry',
  '--userconfig',
  '--globalconfig',
  '--cache',
  '--index',
  '--default-index',
  '--extra-index-url',
  '--index-url',
  '--find-links',
  '--config-file',
  '--project',
  '--constraints',
]);
const BOOLEAN_FLAGS = new Set([
  '-y',
  '--yes',
  '--no-install',
  '--quiet',
  '--silent',
  '--version',
  '-v',
  '--help',
  '-h',
  '--ignore-existing',
]);

function splitPkg(pkg: string): { id: string; version?: string } {
  const at = pkg.lastIndexOf('@');
  if (at > 0) {
    const v = pkg.slice(at + 1);
    return { id: pkg.slice(0, at), version: v || undefined };
  }
  return { id: pkg };
}

const NPM_ID = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const PYPI_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
// Keep benign tags/ranges available to the trust gate. Paths, URLs, aliases,
// credentials and other colon/slash-bearing npm specs remain unverified.
const PACKAGE_VERSION = /^[a-z0-9^~*<>=|][a-z0-9.+_~^*<>=| -]{0,127}$/i;

function registryPackage(pkg: string, ecosystem: 'npm' | 'pypi'): { id: string; version?: string } | null {
  const coordinate = splitPkg(pkg);
  const validId = ecosystem === 'npm' ? NPM_ID.test(coordinate.id) : PYPI_ID.test(coordinate.id);
  if (!validId || (coordinate.version !== undefined && !PACKAGE_VERSION.test(coordinate.version)))
    return null;
  return coordinate;
}

export interface RunnerPackageReference {
  ecosystem: 'npm' | 'pypi';
  coordinate: { id: string; version?: string } | null;
}

interface PackageArgument {
  value: string;
  index: number;
  prefix: string;
}

function executableBase(command: string): string {
  const segment = command.split(/[\\/]/).at(-1) ?? command;
  return segment
    .replace(/^[a-z]:/i, '')
    .replace(/\.(cmd|exe|ps1|bat)$/i, '')
    .toLowerCase();
}

function runnerName(command: string): RunnerKind | null {
  const cmd = executableBase(command);
  return cmd === 'npx' || cmd === 'uvx' || cmd === 'pipx' ? cmd : null;
}

function runnerKind(command: string): RunnerKind | null {
  // A path-qualified executable is user-controlled even when its basename is
  // `npx`/`uvx`/`pipx`. Only the bare platform command names inherit registry
  // provenance; lookalikes are surfaced separately as unverified below.
  if (!/^(?:npx|uvx|pipx)(?:\.(?:cmd|exe|ps1|bat))?$/i.test(command)) return null;
  return runnerName(command);
}

function packageArguments(
  args: string[],
  runner: RunnerKind,
): { packages: PackageArgument[]; ambiguous: boolean } {
  const explicitFlags = runner === 'npx' ? NPM_EXPLICIT_PACKAGE : PYPI_EXPLICIT_PACKAGE;
  const dependencyFlags = runner === 'uvx' ? PYPI_EXTRA_DEPENDENCY : new Set<string>();
  const valueFlags = runner === 'npx' ? NPM_VALUE_FLAGS : new Set<string>();
  const sourceFlags = new Set(SOURCE_OVERRIDE_FLAGS);
  if (runner === 'uvx' || runner === 'pipx') {
    sourceFlags.add('-c'); // uv constraints (not npx --call)
    sourceFlags.add('-p');
    sourceFlags.add('--python');
  }
  const explicit: PackageArgument[] = [];
  const dependencies: PackageArgument[] = [];
  let sourceOverride = false;
  let unknownOption = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (sourceFlags.has(arg)) {
      sourceOverride = true;
      if (i + 1 < args.length) i++;
      continue;
    }
    if ([...sourceFlags].some((flag) => arg.startsWith(`${flag}=`))) {
      sourceOverride = true;
      continue;
    }
    if ((explicitFlags.has(arg) || dependencyFlags.has(arg)) && i + 1 < args.length) {
      if (arg === '--with-editable' || arg === '--with-requirements') sourceOverride = true;
      const target = explicitFlags.has(arg) ? explicit : dependencies;
      target.push({ value: args[i + 1]!, index: i + 1, prefix: '' });
      i++;
      continue;
    }
    const equalAt = arg.indexOf('=');
    const flag = equalAt > 0 ? arg.slice(0, equalAt) : '';
    const flagValue = equalAt > 0 ? arg.slice(equalAt + 1) : '';
    if (flagValue && (explicitFlags.has(flag) || dependencyFlags.has(flag))) {
      if (flag === '--with-editable' || flag === '--with-requirements') sourceOverride = true;
      const target = explicitFlags.has(flag) ? explicit : dependencies;
      target.push({ value: flagValue, index: i, prefix: `${flag}=` });
      continue;
    }
    if (valueFlags.has(arg)) {
      if (i + 1 < args.length) i++;
      continue;
    }
    if (flag && valueFlags.has(flag)) continue;
    if (BOOLEAN_FLAGS.has(arg)) continue;
    if (arg.startsWith('-')) unknownOption = true;
  }
  if (explicit.length > 0) {
    return {
      packages: [...explicit, ...dependencies],
      ambiguous: sourceOverride || unknownOption,
    };
  }
  if (unknownOption) return { packages: dependencies, ambiguous: true };
  let pipxRunSkipped = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('-')) {
      if (sourceFlags.has(arg) || explicitFlags.has(arg) || dependencyFlags.has(arg) || valueFlags.has(arg))
        i++;
      else if (!BOOLEAN_FLAGS.has(arg)) return { packages: dependencies, ambiguous: true };
      continue;
    }
    if (runner === 'pipx' && arg === 'run' && !pipxRunSkipped) {
      pipxRunSkipped = true;
      continue;
    }
    {
      return {
        packages: [{ value: arg, index: i, prefix: '' }, ...dependencies],
        ambiguous: sourceOverride || unknownOption,
      };
    }
  }
  return { packages: dependencies, ambiguous: sourceOverride || unknownOption };
}

export function extractRunnerPackageReferences(spec: McpServerSpec): RunnerPackageReference[] {
  if (spec.transport !== 'stdio') return [];
  const runner = runnerKind(spec.command);
  if (!runner) {
    const lookalike = runnerName(spec.command);
    return lookalike ? [{ ecosystem: lookalike === 'npx' ? 'npm' : 'pypi', coordinate: null }] : [];
  }
  const scan = packageArguments(spec.args ?? [], runner);
  const ecosystem: 'npm' | 'pypi' = runner === 'npx' ? 'npm' : 'pypi';
  const references = scan.packages.map((pkg) => ({
    ecosystem,
    coordinate: registryPackage(pkg.value, ecosystem),
  }));
  if (scan.ambiguous) references.push({ ecosystem, coordinate: null });
  return references;
}

/** Package runners can be redirected away from their default registries by
 * environment alone. Values may be credentials, so expose only the boolean
 * fact to the trust gate. */
export function hasRunnerSourceEnvironment(
  spec: McpServerSpec,
  inheritedEnv: Record<string, string | undefined> = process.env,
): boolean {
  if (spec.transport !== 'stdio') return false;
  const runner = runnerKind(spec.command);
  const keys = Object.keys(spec.env ?? {}).map((key) => key.toUpperCase());
  const inheritedKeys = Object.keys(inheritedEnv).map((key) => key.toUpperCase());
  const proxyOrTrust = /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE)$/;
  const processOrLoader =
    /^(?:PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|COMSPEC|SHELL|XDG_(?:CONFIG|DATA|CACHE)_HOME|BASH_ENV|ENV|SHELLOPTS|CDPATH|LD_.+|DYLD_.+)$/;
  if (keys.some((key) => processOrLoader.test(key))) return true;
  if (runner === 'npx') {
    const explicit = keys.some(
      (key) => key.startsWith('NPM_CONFIG_') || key.startsWith('NODE_') || proxyOrTrust.test(key),
    );
    const inheritedNpmSource =
      /^NPM_CONFIG_(?:REGISTRY|USERCONFIG|GLOBALCONFIG|CACHE|OFFLINE|PREFER_OFFLINE|PROXY|HTTPS_PROXY|CA|CAFILE|CERT|KEY|SCRIPT_SHELL)$/;
    return (
      explicit ||
      inheritedKeys.some(
        (key) =>
          inheritedNpmSource.test(key) ||
          key === 'NODE_OPTIONS' ||
          key === 'NODE_PATH' ||
          proxyOrTrust.test(key),
      )
    );
  }
  if (runner === 'uvx' || runner === 'pipx') {
    const explicit = keys.some(
      (key) =>
        key.startsWith('UV_') ||
        key.startsWith('PIP_') ||
        key.startsWith('PIPX_') ||
        key.startsWith('PYTHON') ||
        proxyOrTrust.test(key),
    );
    const inheritedPythonSource =
      /^(?:UV_(?:INDEX|DEFAULT_INDEX|EXTRA_INDEX_URL|FIND_LINKS|CONFIG_FILE|PROJECT|CONSTRAINT|OVERRIDE|PYTHON)|PIP_(?:INDEX_URL|EXTRA_INDEX_URL|FIND_LINKS|CONFIG_FILE|CONSTRAINT|REQUIREMENT|TRUSTED_HOST|CERT|CLIENT_CERT)|PIPX_DEFAULT_PYTHON|PYTHONPATH|PYTHONHOME)$/;
    return explicit || inheritedKeys.some((key) => inheritedPythonSource.test(key) || proxyOrTrust.test(key));
  }
  return false;
}

/** Replace the primary package runner coordinate while preserving every other
 * flag/argument/env field. Returns null when the runner package is ambiguous or
 * not a valid registry coordinate. */
export function replaceRunnerPackageVersion(spec: McpServerSpec, version: string): McpServerSpec | null {
  if (spec.transport !== 'stdio') return null;
  const runner = runnerKind(spec.command);
  if (!runner) return null;
  const reference = extractRunnerPackageReference(spec);
  const location = packageArguments(spec.args ?? [], runner).packages[0];
  if (!reference?.coordinate || !location) return null;
  const args = [...(spec.args ?? [])];
  const value = version ? `${reference.coordinate.id}@${version}` : reference.coordinate.id;
  args[location.index] = `${location.prefix}${value}`;
  return { ...spec, args };
}

/** Identify package-runner input even when its source spec is unsafe or not a
 * registry coordinate. This lets the trust gate warn/block instead of silently
 * treating file/git/alias inputs as a benign manual command. */
export function extractRunnerPackageReference(spec: McpServerSpec): RunnerPackageReference | null {
  return extractRunnerPackageReferences(spec)[0] ?? null;
}

/** Best-effort package coordinate for an MCP server spec, or null. */
export function extractCoordinate(spec: McpServerSpec): Coordinate | null {
  if (spec.transport === 'stdio') {
    const cmd = executableBase(spec.command);
    const packageReference = extractRunnerPackageReference(spec);
    if (packageReference) {
      return packageReference.coordinate
        ? {
            ecosystem: packageReference.ecosystem,
            ...packageReference.coordinate,
            confidence: 'high',
          }
        : null;
    }
    // running a local script (node/python/deno/bun/ruby ...) → no registry coordinate
    if (['node', 'python', 'python3', 'deno', 'bun', 'ruby'].includes(cmd)) return null;
    return { ecosystem: 'other', id: cmd, confidence: 'low' };
  }
  try {
    return { ecosystem: 'other', id: new URL(spec.url).host, confidence: 'low' };
  } catch {
    return null;
  }
}
