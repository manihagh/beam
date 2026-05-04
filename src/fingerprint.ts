/**
 * Deterministic visual fingerprint for a dashboard.
 *
 * Every dashboard gets its own glyph derived from its uuid. The function is
 * pure: same uuid produces the same SVG every time. This serves three purposes:
 *
 *   1. It gives each dashboard a distinct visual identity that recipients
 *      learn to recognize, without anyone needing to design a logo.
 *   2. It replaces a brand mark in error pages, password challenges, and
 *      email headers, so Beam looks distinctive without claiming a logo.
 *   3. It hints to recipients when they have followed an unexpected link.
 *      A different glyph means a different dashboard. Phishing share links
 *      that point at attacker-controlled hosts will not match the glyph the
 *      recipient remembers.
 *
 * The visual is a 5x5 symmetric grid of squares. Cells are filled or empty
 * based on a deterministic hash of the uuid. Two squares share the same color
 * (a deterministic hue derived from the uuid) so the glyph reads as a small
 * piece of art rather than a barcode.
 *
 * The pattern style is intentionally close to GitHub's identicon, which has
 * over a decade of recognition as "deterministic visual identity for a string."
 */

/** Cheap, deterministic hash for short strings. Returns 32 unsigned bits. */
function hash32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Generate H bits of expanded hash material from a string by re-hashing with index. */
function expandHash(input: string, bytes: number): number[] {
  const out: number[] = [];
  let i = 0;
  while (out.length < bytes) {
    const h = hash32(`${input}#${i}`);
    out.push(h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff, (h >>> 24) & 0xff);
    i++;
  }
  return out.slice(0, bytes);
}

/**
 * Produce a deterministic fingerprint SVG for a uuid.
 *
 * @param uuid     The dashboard uuid.
 * @param size     Pixel dimensions of the square output. Default 96.
 * @param bgColor  Background color. Default white.
 * @returns        Self-contained SVG string suitable for inline embedding.
 */
export function fingerprintSvg(uuid: string, size = 96, bgColor = "#FFFFFF"): string {
  const bytes = expandHash(uuid, 16);

  // Pick a foreground hue derived from the uuid, but bounded to readable
  // saturation and lightness. We keep the saturation moderate and the
  // lightness fixed so glyphs read as distinct without being garish.
  const hue = bytes[0] * 360 / 255;
  const fg = `hsl(${hue.toFixed(0)}, 55%, 38%)`;

  // 5 columns, but mirror left-to-right for symmetry. Compute fill bits for
  // columns 0..2 only (15 cells), then mirror columns 0 and 1 onto 4 and 3.
  const N = 5;
  const cells: boolean[][] = [];
  for (let r = 0; r < N; r++) {
    cells.push([]);
    for (let c = 0; c < N; c++) cells[r].push(false);
  }

  for (let r = 0; r < N; r++) {
    for (let c = 0; c <= 2; c++) {
      // Use bytes[1..15] to drive the 15 left-side cells.
      const byteIndex = 1 + r * 3 + c;
      const filled = (bytes[byteIndex] & 0x80) !== 0;
      cells[r][c] = filled;
      cells[r][N - 1 - c] = filled;
    }
  }

  // Render. Use a 1-cell padding so glyphs do not touch the edge.
  const PAD = 1;
  const cellSize = size / (N + PAD * 2);

  let path = "";
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (cells[r][c]) {
        const x = (c + PAD) * cellSize;
        const y = (r + PAD) * cellSize;
        path += `M${x.toFixed(2)},${y.toFixed(2)}h${cellSize.toFixed(2)}v${cellSize.toFixed(2)}h-${cellSize.toFixed(2)}z`;
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Dashboard glyph">`,
    `<rect width="100%" height="100%" fill="${bgColor}"/>`,
    `<path d="${path}" fill="${fg}"/>`,
    `</svg>`,
  ].join("");
}
