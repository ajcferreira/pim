import sharp from "sharp";

export interface Rendition { name: string; key: string; width: number; height: number; bytes: number; }

const SIZES = [
  { name: "thumb", width: 200 },
  { name: "web", width: 1200 },
];

/**
 * Generate web/thumb renditions for raster images.
 * Returns metadata to store on the asset; files are written via `store`.
 */
export async function generateRenditions(
  buffer: Buffer,
  mime: string,
  baseKey: string,
  store: (buf: Buffer, key: string) => void
): Promise<Rendition[]> {
  if (!/^image\/(png|jpe?g|webp)$/.test(mime)) return [];
  const out: Rendition[] = [];
  for (const s of SIZES) {
    const img = sharp(buffer).resize({ width: s.width, withoutEnlargement: true }).webp({ quality: 82 });
    const buf = await img.toBuffer();
    const meta = await sharp(buf).metadata();
    const key = `${baseKey}.${s.name}.webp`;
    store(buf, key);
    out.push({ name: s.name, key, width: meta.width ?? 0, height: meta.height ?? 0, bytes: buf.length });
  }
  return out;
}
