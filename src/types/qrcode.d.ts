// Minimal types for the part of `qrcode` we use (QR matrix only; the SVG is rendered by us with
// design tokens — no colors from the library). No @types package: one function is not worth a
// second dependency (rule 14).
declare module 'qrcode' {
  export type QRCodeErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';
  export type QRCodeMatrix = {
    modules: { size: number; get(row: number, col: number): number | boolean };
  };
  export function create(
    text: string,
    options?: { errorCorrectionLevel?: QRCodeErrorCorrectionLevel },
  ): QRCodeMatrix;
}
