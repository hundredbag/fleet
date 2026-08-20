import { constants } from 'node:fs';
import { access, lstat, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, sep } from 'node:path';
import type { AgentConfigurationStatus, AgentRuntimeStatus, DetectedAgent } from './types.js';

export interface ConfigurationPathProbe {
  path: string;
  kind: 'file' | 'directory';
  /** Shared paths may be inspected without proving this particular agent is configured. */
  countsAsPresent?: boolean;
}

export interface ConfigurationProbeResult {
  present: boolean;
  status: AgentConfigurationStatus;
  note?: string;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Inspect known local configuration paths without following symlink leaves.
 * A present but unreadable/wrong-type path is unavailable, never healthy or
 * absent. The returned note is local diagnostic text and is not a public DTO.
 */
export async function probeConfigurationPaths(
  paths: ConfigurationPathProbe[],
): Promise<ConfigurationProbeResult> {
  let present = false;
  const unavailable: string[] = [];

  for (const entry of paths) {
    let info;
    try {
      info = await lstat(entry.path);
      if (entry.countsAsPresent !== false) present = true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      unavailable.push(`${entry.path} cannot be inspected`);
      continue;
    }

    if (info.isSymbolicLink()) {
      unavailable.push(`${entry.path} is a symbolic link`);
      continue;
    }
    const expectedType = entry.kind === 'file' ? info.isFile() : info.isDirectory();
    if (!expectedType) {
      unavailable.push(`${entry.path} is not a ${entry.kind}`);
      continue;
    }
    try {
      await access(entry.path, constants.R_OK | (entry.kind === 'directory' ? constants.X_OK : 0));
    } catch {
      unavailable.push(`${entry.path} is not readable`);
    }
  }

  if (unavailable.length > 0) {
    return { present, status: 'unavailable', note: unavailable.join('; ') };
  }
  return { present, status: present ? 'configured' : 'not-configured' };
}

function executableCandidates(command: string): string[] | undefined {
  if (isAbsolute(command) || command.includes(sep)) return [command];
  const pathValue = process.env.PATH;
  if (pathValue === undefined) return undefined;
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  const hasExtension = extname(command) !== '';
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) =>
      hasExtension
        ? [join(directory, command)]
        : extensions.map((extension) => join(directory, command + extension)),
    );
}

/** Determine whether a vendor executable is locally runnable without invoking it. */
export async function probeExecutable(command: string): Promise<AgentRuntimeStatus> {
  const candidates = executableCandidates(command);
  if (!candidates) return 'unverifiable';
  let unexpectedFailure = false;
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, constants.X_OK);
      return 'available';
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES') unexpectedFailure = true;
    }
  }
  return unexpectedFailure ? 'unverifiable' : 'not-found';
}

/** BYO adapters may omit the additive status; an explicit unknown value fails closed. */
export function detectionAllowsMutation(detected: DetectedAgent): boolean {
  return (
    detected.configurationStatus === undefined ||
    detected.configurationStatus === 'configured' ||
    detected.configurationStatus === 'not-configured'
  );
}
