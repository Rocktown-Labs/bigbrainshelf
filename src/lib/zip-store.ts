// Minimal store-only ZIP writer (no compression). Book
// deliverables are already-compressed media (PDF, JPG, EPUB,
// M4B), so stored entries cost nothing in size and keep the
// writer tiny and dependency-free. Produces a standard ZIP:
// local headers, central directory, EOCD. Files must each be
// under 4GB (ours are tens of MB).

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time =
    ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date =
    (((Math.max(0, d.getFullYear() - 1980)) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0xf) << 5) |
    (d.getDate() & 0x1f);
  return { time, date };
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  mtime?: Date;
}

export function buildStoredZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (v: number) => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    return b;
  };
  const u32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    return b;
  };
  const push = (arr: Uint8Array[], ...parts: Uint8Array[]) => {
    for (const p of parts) arr.push(p);
  };

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const { time, date } = dosDateTime(e.mtime ?? new Date());
    const local: Uint8Array[] = [];
    push(
      local,
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(time), u16(date),
      u32(crc), u32(e.data.length), u32(e.data.length),
      u16(nameBytes.length), u16(0), nameBytes, e.data
    );
    const localSize = local.reduce((a, b) => a + b.length, 0);
    chunks.push(...local);

    const cen: Uint8Array[] = [];
    push(
      cen,
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(date),
      u32(crc), u32(e.data.length), u32(e.data.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), nameBytes
    );
    central.push(...cen);
    offset += localSize;
  }

  const centralStart = offset;
  const centralSize = central.reduce((a, b) => a + b.length, 0);
  chunks.push(...central);
  const eocd: Uint8Array[] = [];
  push(
    eocd,
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralSize), u32(centralStart), u16(0)
  );
  chunks.push(...eocd);

  const total = chunks.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
