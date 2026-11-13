"use client";
import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** QR on a white tile in both themes, so phone cameras read it reliably. */
export function QrCode({ value, label, size = 176 }: { value: string; label: string; size?: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#111214", light: "#ffffff" } })
      .then((s) => live && setSvg(s))
      .catch(() => live && setSvg(null));
    return () => { live = false; };
  }, [value]);
  return (
    <div role="img" aria-label={label} style={{ width: size, height: size }} className="shrink-0 overflow-hidden rounded-lg bg-white p-2 shadow-sm ring-1 ring-line">
      {svg ? <div className="h-full w-full [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="h-full w-full animate-pulse rounded bg-[#eee]" />}
    </div>
  );
}

export async function downloadQrSvg(value: string, filename: string) {
  const svg = await QRCode.toString(value, { type: "svg", margin: 2, color: { dark: "#111214", light: "#ffffff" } });
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
