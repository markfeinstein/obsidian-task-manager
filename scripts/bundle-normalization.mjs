/**
 * Canonicalize generated JavaScript line endings without changing executable
 * tokens. Some dependency debug template literals retain source-line padding
 * after minification; trimming only horizontal whitespace immediately before a
 * line ending keeps the tracked artifact diff-clean and deterministic.
 */
export function normalizeGeneratedBundle(source) {
  return source.replace(/[\t ]+(?=\r?$)/gmu, '');
}
