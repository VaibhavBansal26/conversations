import { crc32, deflateSync } from "node:zlib";

/** A generated placeholder portrait (a gradient with a plain head and shoulders): screenshots and tests never use a real photograph. */
export function placeholderPng(size = 256, hue: [number, number, number] = [79, 70, 229]): Buffer {
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const o = y * (1 + size * 3);
    raw[o] = 0;
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      let r = 230 - t * 70, g = 232 - t * 60, b = 245 - t * 30;
      const head = Math.hypot(x - size / 2, y - size * 0.4) < size * 0.18;
      const shoulders = Math.hypot((x - size / 2) / 1.5, y - size * 1.02) < size * 0.4;
      if (head || shoulders) [r, g, b] = [hue[0] + (head ? 60 : 0), hue[1] + (head ? 60 : 0), hue[2]];
      const p = o + 1 + x * 3;
      raw[p] = Math.min(255, r);
      raw[p + 1] = Math.min(255, g);
      raw[p + 2] = Math.min(255, b);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
