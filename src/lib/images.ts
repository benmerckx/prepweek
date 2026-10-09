// Photos and screenshots attached to tasks are made smaller before they're
// stored and uploaded: at most 2560 px on the long side, as WebP (JPEG where
// a browser can't write WebP). A phone photo goes from ~4 MB to ~300 KB and
// still looks the same at any size the app shows it. Anything else (GIFs,
// SVGs, PDFs, small images) is kept as it is, and so is a result that
// wouldn't be smaller.

const MAX_SIDE = 2560;
/** Below this, not worth it. */
const MIN_BYTES = 300 * 1024;
const SHRINKABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const encode = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

export const shrinkImage = async (file: File): Promise<File> => {
  if (!SHRINKABLE.has(file.type) || file.size < MIN_BYTES || typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    // Screenshots (PNG) keep crisp text with a little more quality.
    const quality = file.type === 'image/png' ? 0.9 : 0.82;
    let blob = await encode(canvas, 'image/webp', quality);
    if (!blob || blob.type !== 'image/webp') blob = await encode(canvas, 'image/jpeg', quality);
    if (!blob || blob.size >= file.size) return file;
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
    const name = file.name ? file.name.replace(/\.[^.]+$/, '') + '.' + ext : `image.${ext}`;
    return new File([blob], name, { type: blob.type, lastModified: file.lastModified });
  } catch {
    return file;
  }
};
