'use client';

import { create } from 'qrcode';
import { useMemo } from 'react';

// QR code drawn as SVG from the library's module matrix: dark modules use the text token,
// the quiet zone and light modules the surface token (no colors in code).
export function QrCode({ value, label }: { value: string; label: string }) {
  const path = useMemo(() => {
    const { modules } = create(value, { errorCorrectionLevel: 'M' });
    const parts: string[] = [];
    for (let row = 0; row < modules.size; row += 1) {
      for (let col = 0; col < modules.size; col += 1) {
        if (modules.get(row, col)) parts.push(`M${col + 4} ${row + 4}h1v1h-1z`);
      }
    }
    return { d: parts.join(''), size: modules.size + 8 };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${path.size} ${path.size}`}
      shapeRendering="crispEdges"
      className="h-48 w-48 rounded-md bg-surface text-text"
    >
      <rect width={path.size} height={path.size} className="fill-surface" />
      <path d={path.d} fill="currentColor" />
    </svg>
  );
}
