/** Verify file content matches its claimed mimetype by magic bytes.
 *  Known types must match; unknown types pass (validated elsewhere). */
const SIGNATURES: { mime: RegExp; check: (b: Buffer) => boolean }[] = [
  { mime: /^image\/png$/,  check: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { mime: /^image\/jpe?g$/, check: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: /^image\/webp$/, check: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  { mime: /^image\/gif$/,  check: (b) => b.length > 6 && /^GIF8[79]a/.test(b.toString("ascii", 0, 6)) },
  { mime: /^application\/pdf$/, check: (b) => b.length > 5 && b.toString("ascii", 0, 5) === "%PDF-" },
  { mime: /^application\/zip$/, check: (b) => b.length > 4 && b.readUInt32LE(0) === 0x04034b50 },
];

export function contentMatchesMime(buffer: Buffer, claimedMime: string): boolean {
  const sig = SIGNATURES.find((s) => s.mime.test(claimedMime));
  return sig ? sig.check(buffer) : true;
}
