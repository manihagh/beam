/**
 * QR code SVG generator. Uses the `qrcode-svg` package (port of the
 * battle-tested kazuhiko-arase library, no DOM deps, runs in Workers).
 *
 * Color is fixed to neutral ink on white so the QR renders cleanly in
 * every email client and looks correct regardless of brand color. Brand
 * accents elsewhere in the UI do not change the QR.
 */

import QRCode from "qrcode-svg";

export function generateQrSvg(text: string): string {
  const qr = new QRCode({
    content: text,
    padding: 4,
    width: 320,
    height: 320,
    color: "#1B1A18",
    background: "#FFFFFF",
    ecl: "M",
    join: true,
    container: "svg-viewbox",
  });
  let svg = qr.svg();
  // Strip the `<?xml ?>` prologue so the SVG is safe to drop into innerHTML.
  svg = svg.replace(/^<\?xml[^?]*\?>\s*/i, "");
  return svg;
}
