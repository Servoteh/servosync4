// Klijentski resize vision priloga (paritet 1.0 prepareImageForUpload): najduža
// stranica ≤ 1568px, bela pozadina, JPEG q0.82. GIF se šalje bez resize-a
// (animacija). Vraća Blob za multipart `image` u /ai/chat.

const MAX_DIM = 1568;

export async function resizeImageFile(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Slika nije učitana.'));
      im.src = url;
    });
    let { width, height } = img;
    if (width > MAX_DIM || height > MAX_DIM) {
      const scale = MAX_DIM / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.82),
    );
    return blob ?? file;
  } finally {
    URL.revokeObjectURL(url);
  }
}
