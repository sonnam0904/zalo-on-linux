// Recover RegisterNatives tables without executing JNI_OnLoad or inventing a VM.
// Table locations/counts come from the four calls in JNI_OnLoad of this build.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const file = process.argv[2];
if (!file) throw new Error('Usage: node extract-jni.mjs /path/libzrtc.so');
const elf = fs.readFileSync(file);
const hash = createHash('sha256').update(elf).digest('hex');
if (hash !== 'c7e5f005fd5c12dc64d72008a1871638246899a9cf6b034dc13981c014caeefe')
  throw new Error('Unsupported build: re-derive JNI_OnLoad table locations first');
const u64 = offset => Number(elf.readBigUInt64LE(offset));
const segments = [];
for (let i = 0; i < elf.readUInt16LE(56); i++) {
  const p = u64(32) + i * elf.readUInt16LE(54);
  if (elf.readUInt32LE(p) === 1)
    segments.push({ offset: u64(p + 8), addr: u64(p + 16), size: u64(p + 32) });
}
function off(addr) {
  const s = segments.find(s => addr >= s.addr && addr < s.addr + s.size);
  if (!s) throw new Error(`Unmapped ELF address ${addr.toString(16)}`);
  return s.offset + addr - s.addr;
}
// Account for RELA addends; dynamic pointers need not live in their data slots.
const relocations = new Map();
for (let i = 0; i < elf.readUInt16LE(60); i++) {
  const s = u64(40) + i * elf.readUInt16LE(58);
  if (elf.readUInt32LE(s + 4) !== 4) continue;
  const start = u64(s + 24), size = u64(s + 32), stride = u64(s + 56);
  for (let p = start; p < start + size; p += stride) {
    // R_X86_64_RELATIVE = 8. Function pointers may instead use symbol relocations.
    const info = elf.readBigUInt64LE(p + 8);
    let addr = Number(elf.readBigInt64LE(p + 16));
    if (Number(info & 0xffffffffn) !== 8) {
      const symIndex = Number(info >> 32n);
      const symSection = u64(40) + elf.readUInt32LE(s + 40) * elf.readUInt16LE(58);
      addr += u64(u64(symSection + 24) + symIndex * u64(symSection + 56) + 8);
    }
    relocations.set(u64(p), addr);
  }
}
const ptr = addr => relocations.get(addr) ?? u64(off(addr));
function str(addr) {
  const p = off(addr), end = elf.indexOf(0, p);
  if (end < p) throw new Error('Unterminated ELF string');
  return elf.toString('utf8', p, end);
}
const tables = [
  [0x6bedea, 0x834010, 25], [0x6bee16, 0x834270, 99],
  [0x6bee33, 0x834bc0, 9], [0x6bee60, 0x834ca0, 40],
];
console.log(`# SHA256 ${hash}\nclass\tmethod\tsignature\telf_address`);
for (const [klass, table, count] of tables)
  for (let i = 0; i < count; i++) {
    const a = table + i * 24;
    console.log([str(klass), str(ptr(a)), str(ptr(a + 8)), '0x' + ptr(a + 16).toString(16)].join('\t'));
  }
