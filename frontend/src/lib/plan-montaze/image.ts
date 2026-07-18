// Plan montaže — client-side downscale fotki (port 1:1 iz 1.0 imageDownscale.js).
// Jedna downscale-ovana verzija služi za AI (base64), storage (blob) i PDF/preview (dataUrl).
// createImageBitmap sa imageOrientation:'from-image' poštuje EXIF rotaciju (telefon portret).

const MAX_PX = 1568;
const QUALITY = 0.72;

export interface DownscaledPhoto {
  dataUrl: string;
  base64: string;
  blob: Blob;
  w: number;
  h: number;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export async function downscaleImageToJpeg(
  file: File | Blob,
  { maxPx = MAX_PX, quality = QUALITY }: { maxPx?: number; quality?: number } = {},
): Promise<DownscaledPhoto> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(file);
  }

  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; // beli background (JPEG nema alfu)
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (typeof bitmap.close === 'function') bitmap.close();

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const base64 = dataUrl.split(',')[1] || '';
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

  return { dataUrl, base64, blob: blob || dataUrlToBlob(dataUrl), w, h };
}
