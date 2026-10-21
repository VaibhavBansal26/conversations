import { crc32, deflateSync } from "node:zlib";

/** Generated placeholder pictures for tests (no real photographs anywhere in the repository). */
const chunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
};

export function png(w = 128, h = 128, extra: { type: string; data: Buffer }[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3, 0x7a);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extra.map((e) => chunk(e.type, e.data)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** a structurally valid baseline JPEG skeleton (the cleaner reads structure, not pixels) with an EXIF block that carries a marker string */
export function jpeg(w = 128, h = 128, o: { exif?: string; progressive?: boolean } = {}): Buffer {
  const seg = (m: number, data: Buffer) => Buffer.concat([Buffer.from([0xff, m]), Buffer.from([(data.length + 2) >> 8, (data.length + 2) & 0xff]), data]);
  const sof = Buffer.from([8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    ...(o.exif ? [seg(0xe1, Buffer.from(`Exif\0\0${o.exif}`, "latin1")), seg(0xfe, Buffer.from(`comment ${o.exif}`, "latin1"))] : []),
    seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 16)])),
    seg(o.progressive ? 0xc2 : 0xc0, sof),
    seg(0xc4, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(16, 0), Buffer.from([0])])),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0x00, 0x78]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** a lossless WebP skeleton (VP8L) inside an extended header, with an EXIF chunk that carries a marker string */
export function webp(w = 128, h = 128, o: { exif?: string; animated?: boolean } = {}): Buffer {
  const ck = (id: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, "latin1");
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x[0] = (o.exif ? 0x08 : 0) | (o.animated ? 0x02 : 0);
  vp8x.writeUIntLE(w - 1, 4, 3);
  vp8x.writeUIntLE(h - 1, 7, 3);
  const vp8l = Buffer.alloc(9);
  vp8l[0] = 0x2f;
  vp8l.writeUInt32LE((w - 1) | ((h - 1) << 14), 1);
  const body = Buffer.concat([ck("VP8X", vp8x), ck("VP8L", vp8l), ...(o.exif ? [ck("EXIF", Buffer.from(`Exif\0\0${o.exif}`, "latin1"))] : []), ...(o.animated ? [ck("ANIM", Buffer.alloc(6))] : [])]);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write("WEBP", 8, "latin1");
  return Buffer.concat([riff, body]);
}
