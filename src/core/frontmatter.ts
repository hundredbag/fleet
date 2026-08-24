import { isMap, isScalar, parseDocument } from 'yaml';

/** The only frontmatter form Fleet accepts is inert YAML between exact `---`
 * delimiters. JavaScript frontmatter and non-mapping documents are rejected. */
export type FrontmatterScalar =
  { status: 'missing' | 'ambiguous' | 'invalid' } | { status: 'value'; value: string };

export function parseFrontmatterScalar(
  text: string,
  key: string,
  options: { allowNumeric?: boolean } = {},
): FrontmatterScalar {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return { status: 'invalid' };
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { status: 'missing' };

  try {
    const document = parseDocument(match[1]!, {
      prettyErrors: false,
      uniqueKeys: true,
      version: '1.2',
    });
    if (document.errors.some((error) => error.code === 'DUPLICATE_KEY')) {
      return { status: 'ambiguous' };
    }
    if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents)) {
      return { status: 'invalid' };
    }
    if (!document.has(key)) return { status: 'missing' };
    const scalar = document.get(key, true);
    if (!isScalar(scalar)) return { status: 'invalid' };
    const value: unknown = scalar.value;
    if (typeof value === 'string') return { status: 'value', value };
    if (
      options.allowNumeric === true &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      typeof scalar.source === 'string'
    ) {
      // Versions are identifiers, not quantities. Preserve the YAML token so
      // 1.0, 2.10, exponent forms, and integers beyond JS precision do not
      // silently change their public metadata value.
      return { status: 'value', value: scalar.source };
    }
    return { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}
