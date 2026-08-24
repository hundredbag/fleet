import { FleetOperationError } from './errors.js';

/** Vendor plugin identity has two distinct parts. `name` is the installed
 * capability identity; `marketplace` selects a configured catalog. The joined
 * `name@marketplace` form exists only at vendor CLI and ledger boundaries. */
export interface PluginCoordinate {
  name: string;
  marketplace?: string;
  selector: string;
}

export const PLUGIN_NAME_RE = /^(@[\w][\w.-]*\/)?[\w][\w.-]*$/;
export const MARKETPLACE_RE = /^[\w][\w.-]*$/;
export const SELECTOR_RE = /^(@[\w][\w.-]*\/)?[\w][\w.-]*(@[\w][\w.-]*)?$/;

export function pluginCoordinate(value: string, marketplace?: string): PluginCoordinate {
  if (marketplace !== undefined) {
    if (!PLUGIN_NAME_RE.test(value) || value.includes('..')) {
      const parsedAsSelector = SELECTOR_RE.test(value) && value.lastIndexOf('@') > 0;
      if (parsedAsSelector) {
        throw new FleetOperationError(
          'INVALID_ARGUMENT',
          'plugin name and marketplace must be supplied separately',
        );
      }
      throw new FleetOperationError(
        'REQUEST_REJECTED',
        `refusing unsafe plugin selector '${value}@${marketplace}'`,
      );
    }
    if (!MARKETPLACE_RE.test(marketplace) || marketplace.includes('..')) {
      throw new FleetOperationError(
        'REQUEST_REJECTED',
        `refusing unsafe plugin selector '${value}@${marketplace}'`,
      );
    }
    return { name: value, marketplace, selector: `${value}@${marketplace}` };
  }

  if (!SELECTOR_RE.test(value) || value.includes('..')) {
    throw new FleetOperationError('REQUEST_REJECTED', `refusing unsafe plugin selector '${value}'`);
  }
  const at = value.lastIndexOf('@');
  if (at > 0) {
    return { name: value.slice(0, at), marketplace: value.slice(at + 1), selector: value };
  }
  return { name: value, selector: value };
}
