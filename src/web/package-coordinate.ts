export interface WebPackageCoordinate {
  ecosystem?: string;
  identifier?: string;
  version?: string;
}

// Keep the discovery advertisement and the preview planner on one grammar.
// These are registry package names, never flags, paths, URLs, git specs, or
// aliases. A version is optional, but when present it is one safe token.
const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const PYPI_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const VERSION = /^[a-z0-9][a-z0-9.+-]*$/i;

export function isValidWebPackageCoordinate(
  coordinate: WebPackageCoordinate | undefined,
): coordinate is WebPackageCoordinate & { identifier: string } {
  if (!coordinate?.identifier) return false;
  if (coordinate.identifier.length > 200 || (coordinate.version?.length ?? 0) > 64) return false;
  const validName =
    coordinate.ecosystem === 'npm'
      ? NPM_NAME.test(coordinate.identifier)
      : coordinate.ecosystem === 'pypi'
        ? PYPI_NAME.test(coordinate.identifier)
        : false;
  return (
    validName &&
    (coordinate.version === undefined || coordinate.version === '' || VERSION.test(coordinate.version))
  );
}

export function assertValidWebPackageCoordinate(
  coordinate: WebPackageCoordinate | undefined,
): asserts coordinate is WebPackageCoordinate & { identifier: string } {
  if (!coordinate?.identifier) throw new Error('install requires a package coordinate');
  if (!isValidWebPackageCoordinate(coordinate)) {
    if (coordinate.version !== undefined && coordinate.version !== '' && !VERSION.test(coordinate.version)) {
      throw new Error(`refusing unsafe version '${coordinate.version}'`);
    }
    throw new Error(
      `refusing unsafe package identifier '${coordinate.identifier}' (ecosystem '${coordinate.ecosystem ?? '?'}')`,
    );
  }
}
