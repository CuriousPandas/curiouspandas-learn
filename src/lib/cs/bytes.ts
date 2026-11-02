// The logic behind the text and picture labs: what bytes a string becomes, and what
// happens when those bytes are read back with the wrong rule.
//
// This is a model of three encodings only: UTF-8, Latin-1 and Windows-1252. It isn't
// Python's codecs module and it refuses anything else. The code lab's Python has no
// str.encode() or bytes, so this file is the only byte-level code on those pages, and
// the test holds it to the real .encode() and .decode(), wrong inputs included.

import type { Mission } from '../missions.ts';

export type Encoding = 'utf-8' | 'latin-1' | 'cp1252';
export const ENCODINGS: { id: Encoding; label: string }[] = [
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'cp1252', label: 'Windows-1252' },
  { id: 'latin-1', label: 'Latin-1' },
];

export const codePoints = (text: string): number[] => [...text].map((c) => c.codePointAt(0)!);
export const showCodePoint = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
export const isSurrogate = (cp: number) => cp >= 0xd800 && cp <= 0xdfff;

/** RFC 3629's table. A surrogate has no encoding in UTF-8, and Python refuses it too. */
export function utf8Of(cp: number): number[] | null {
  if (isSurrogate(cp) || cp < 0 || cp > 0x10ffff) return null;
  if (cp < 0x80) return [cp];
  const tail = (shift: number) => 0x80 | (Math.floor(cp / 2 ** shift) & 0x3f);
  if (cp < 0x800) return [0xc0 | (cp >> 6), tail(0)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), tail(6), tail(0)];
  return [0xf0 | (cp >> 18), tail(12), tail(6), tail(0)];
}

// Byte 0x80 to 0x9F in Windows-1252. The five holes really are undefined in Python's
// table. WHATWG's windows-1252 fills them with control characters, so TextDecoder would
// give a different answer on exactly the bytes that matter here.
const CP1252_HIGH: (number | null)[] = [
  0x20ac, null, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, null, 0x017d, null,
  null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, null, 0x017e, 0x0178,
];
const cp1252Back = new Map<number, number>();
CP1252_HIGH.forEach((cp, i) => { if (cp !== null) cp1252Back.set(cp, 0x80 + i); });

export type Encoded = { ok: true; bytes: number[] } | { ok: false; at: number; codePoint: number };

/** text.encode(encoding), strict. On failure it says which character, as Python's error does. */
export function encode(text: string, encoding: Encoding): Encoded {
  const out: number[] = [];
  const cps = codePoints(text);
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    let bytes: number[] | null = null;
    if (encoding === 'utf-8') bytes = utf8Of(cp);
    else if (encoding === 'latin-1') bytes = cp < 256 ? [cp] : null;
    else if (cp < 0x80 || (cp >= 0xa0 && cp < 0x100)) bytes = [cp];
    else if (cp1252Back.has(cp)) bytes = [cp1252Back.get(cp)!];
    if (!bytes) return { ok: false, at: i, codePoint: cp };
    out.push(...bytes);
  }
  return { ok: true, bytes: out };
}

export const REPLACEMENT = 0xfffd;

/**
 * bytes.decode(encoding, errors='replace'). Each bad sequence becomes U+FFFD, the way
 * Python counts them, and `replaced` says how many: that character is the point where
 * information was lost for good.
 */
export function decode(bytes: number[], encoding: Encoding): { text: string; replaced: number } {
  let text = '', replaced = 0;
  const bad = () => { text += String.fromCodePoint(REPLACEMENT); replaced++; };
  if (encoding !== 'utf-8') {
    for (const b of bytes) {
      if (encoding === 'latin-1' || b < 0x80 || b >= 0xa0) text += String.fromCodePoint(b);
      else { const cp = CP1252_HIGH[b - 0x80]; if (cp === null) bad(); else text += String.fromCodePoint(cp); }
    }
    return { text, replaced };
  }
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) { text += String.fromCodePoint(b); i++; continue; }
    // The first continuation byte's range depends on the lead byte: that's what rules out overlong forms, surrogates and anything past U+10FFFF.
    let need = 0, low = 0x80, high = 0xbf, cp = 0;
    if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; }
    else if (b >= 0xe0 && b <= 0xef) { need = 2; cp = b & 0x0f; if (b === 0xe0) low = 0xa0; if (b === 0xed) high = 0x9f; }
    else if (b >= 0xf0 && b <= 0xf4) { need = 3; cp = b & 0x07; if (b === 0xf0) low = 0x90; if (b === 0xf4) high = 0x8f; }
    else { bad(); i++; continue; }
    let j = i + 1, good = true;
    for (let k = 0; k < need; k++, j++) {
      const c = bytes[j];
      if (c === undefined || c < low || c > high) { good = false; break; }
      cp = cp * 64 + (c & 0x3f);
      low = 0x80; high = 0xbf;
    }
    if (!good) { bad(); i = j; continue; }
    text += String.fromCodePoint(cp);
    i = j;
  }
  return { text, replaced };
}

export const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');
export const bin8 = (b: number) => b.toString(2).padStart(8, '0');

// ---- The text lab ----------------------------------------------------------------------

export type TextEvent =
  | { op: 'read'; text: string; encoding: Encoding; result: string; replaced: number; maxBytes: number }
  | { op: 'repair'; garbled: string; encoding: Encoding; ok: boolean; result: string };
export type TextState = { text: string; encoding: Encoding; events: TextEvent[] };
export const textState = (): TextState => ({ text: 'Café', encoding: 'utf-8', events: [] });

const widest = (text: string) => Math.max(0, ...codePoints(text).map((c) => utf8Of(c)?.length ?? 0));

/** The UTF-8 bytes of the text, read back with the chosen rule. Null if the text itself can't be encoded. */
export function readBack(s: TextState): { bytes: number[]; text: string; replaced: number } | null {
  const e = encode(s.text, 'utf-8');
  if (!e.ok) return null;
  const d = decode(e.bytes, s.encoding);
  return { bytes: e.bytes, ...d };
}

/**
 * The count line. It says code points because that's what it counts: the UK flag once showed
 * as "2 characters", under a lesson that says one character on screen can be several code points.
 */
export function describeCount(text: string): string | null {
  const e = encode(text, 'utf-8');
  if (!e.ok) return null;
  const n = codePoints(text).length, b = e.bytes.length;
  return `${n} code point${n === 1 ? '' : 's'}, ${b} byte${b === 1 ? '' : 's'} in UTF-8.`;
}

export function logRead(s: TextState) {
  const r = readBack(s);
  if (r) s.events.push({ op: 'read', text: s.text, encoding: s.encoding, result: r.text, replaced: r.replaced, maxBytes: widest(s.text) });
}

/** The classic repair: turn the garbled text back into bytes with the wrong rule, then read them with the right one. */
export function repair(garbled: string, encoding: Encoding): { ok: true; result: string } | { ok: false; why: string } {
  const e = encode(garbled, encoding);
  if (!e.ok) {
    const c = String.fromCodePoint(e.codePoint);
    return { ok: false, why: e.codePoint === REPLACEMENT
      ? 'The garbled text contains the replacement character. The original byte was thrown away when that was written, so nothing can bring it back.'
      : `"${c}" has no byte in that encoding, so the bytes can't be recovered.` };
  }
  const d = decode(e.bytes, 'utf-8');
  if (d.replaced) return { ok: false, why: 'Those bytes are not valid UTF-8, so this text was not garbled in the way this repair undoes.' };
  return { ok: true, result: d.text };
}

export function doRepair(s: TextState): ReturnType<typeof repair> | null {
  const r = readBack(s);
  if (!r) return null;
  const fixed = repair(r.text, s.encoding);
  s.events.push({ op: 'repair', garbled: r.text, encoding: s.encoding, ok: fixed.ok, result: fixed.ok ? fixed.result : '' });
  return fixed;
}

const misread = (e: TextEvent) => e.op === 'read' && e.encoding !== 'utf-8';
const misreadAs1252 = (e: TextEvent) => e.op === 'read' && e.encoding === 'cp1252';

export const TEXT_MISSION: Mission<TextState> = {
  id: 'comp-text-mojibake', title: 'The bytes were fine', xp: 70, setup: textState,
  steps: [
    { text: 'Find a character that takes at least three bytes in UTF-8', hint: 'Type € or 日, or paste an emoji', done: (s) => s.events.some((e) => e.op === 'read' && e.maxBytes >= 3) },
    { text: 'Read a non-English word back as Windows-1252 and see it come out wrong', hint: 'Type Café, and choose Windows-1252', done: (s) => s.events.some((e) => misreadAs1252(e) && e.op === 'read' && e.result !== e.text) },
    { text: 'Find text that survives being read wrongly', hint: 'Plain ASCII letters, such as Cafe', done: (s) => s.events.some((e) => misread(e) && e.op === 'read' && e.result === e.text && e.text.length > 0) },
    { text: 'Repair some garbled text: it comes back identical', hint: 'Type Café, choose Windows-1252, press Repair', done: (s) => s.events.some((e) => e.op === 'repair' && e.ok && e.result !== e.garbled && !!e.result) },
    { text: 'Now find a character the repair can\'t save', hint: 'Type Á, choose Windows-1252, press Repair', done: (s) => s.events.some((e) => e.op === 'repair' && !e.ok) },
  ],
  debrief: 'Nothing was wrong with the bytes. Text is numbers plus an agreement about what they mean, and when two programs disagree the bytes still get read, without an error. That\'s why pure ASCII survives while é and a curly apostrophe don\'t: UTF-8 and the other two encodings in this lab agree on the first 128 values. The repair works when the wrong reading kept every byte. If a byte was replaced on the way, it was lost, and the original can\'t be worked out from what\'s left.',
};

// ---- The picture lab -------------------------------------------------------------------

export type PictureState = { bytes: number[]; width: number; channels: 1 | 3; offset: number; seen: { width: number; channels: number; offset: number }[]; painted: { index: number; rgb: number[]; before: number[] }[] };

// A panda face, 8 pixels by 8, as raw red, green, blue bytes. `.` paper, `#` black fur, `w` white fur, `p` pink.
const ROWS = [
  '##....##',
  '##wwww##',
  '.wwwwww.',
  '.w##w##.',
  '.wwwwww.',
  '.www#ww.',
  '.wwpppw.',
  '..wwww..',
];
const PAL: Record<string, number[]> = { '.': [120, 200, 120], '#': [20, 20, 20], w: [245, 245, 245], p: [240, 150, 170] };
export const PICTURE_WIDTH = 8;
export const PICTURE_BYTES: number[] = ROWS.flatMap((r) => [...r].flatMap((c) => PAL[c]));

export const pictureState = (): PictureState => ({ bytes: [...PICTURE_BYTES], width: PICTURE_WIDTH, channels: 3, offset: 0, seen: [], painted: [] });

export type Grid = { rows: number[][][]; leftover: number; pixels: number };

/** The bytes laid out as a reader with these settings would: nothing in the bytes says what the settings should be. */
export function layout(bytes: number[], width: number, channels: 1 | 3, offset: number): Grid {
  if (!Number.isInteger(width) || width < 1) throw new Error(`layout: width ${width}`);
  const usable = bytes.slice(offset);
  const pixels = Math.floor(usable.length / channels);
  const rows: number[][][] = [];
  for (let i = 0; i < pixels; i++) {
    const at = i * channels;
    const px = channels === 3 ? usable.slice(at, at + 3) : [usable[at], usable[at], usable[at]];
    const row = Math.floor(i / width);
    (rows[row] ??= []).push(px);
  }
  return { rows, pixels, leftover: usable.length - pixels * channels };
}

export const rawSize = (width: number, height: number, channels: number) => width * height * channels;

const correct = (v: { width: number; channels: number; offset: number }) => v.width === PICTURE_WIDTH && v.channels === 3 && v.offset === 0;

type Reading = { width: number; channels: number; offset: number };
const wrongWidth = (v: Reading) => v.width !== PICTURE_WIDTH && v.channels === 3 && v.offset === 0;
const wrongChannels = (v: Reading) => v.channels === 1;
const wrongOffset = (v: Reading) => v.offset % 3 !== 0 && v.channels === 3;

/**
 * "Put all three settings back" means back after all three were broken. Checking only that a
 * correct reading was ever seen ticked this as soon as the width went 7 then 8, with the skip
 * still at 1 and two wrong settings yet to come.
 */
function putBack(seen: Reading[]): boolean {
  const broken = [wrongWidth, wrongChannels, wrongOffset].map((wrong) => seen.findIndex(wrong));
  if (broken.includes(-1)) return false;
  return seen.slice(Math.max(...broken) + 1).some(correct);
}

export const PICTURE_MISSION: Mission<PictureState> = {
  id: 'comp-picture-bytes', title: 'The same bytes, read wrongly', xp: 60, setup: pictureState,
  steps: [
    { text: 'Change the width, so the reader starts each new row in the wrong place', hint: 'Set the width to 7', done: (s) => s.seen.some(wrongWidth) },
    { text: 'Read it as one byte per pixel, grey, instead of three', hint: 'Change Bytes per pixel to 1', done: (s) => s.seen.some(wrongChannels) },
    { text: 'Slip by one byte: skip the first byte and read on', hint: 'Set Skip bytes to 1', done: (s) => s.seen.some(wrongOffset) },
    { text: 'Put all three settings back, so the picture is right', hint: 'Width 8, 3 bytes per pixel, skip 0', done: (s) => putBack(s.seen) },
    { text: 'Paint a pixel pure red, and find its three bytes', hint: 'Press a pixel with Red chosen. It should read FF 00 00', done: (s) => s.painted.some((p) => p.rgb[0] === 255 && p.rgb[1] === 0 && p.rgb[2] === 0) },
  ],
  debrief: 'A raw picture is one long row of bytes. Nothing in those bytes says where a row ends or which byte is red: that\'s an agreement, and you changed it three ways before you touched a byte. Painting was the one thing that changed bytes: three of them. Real image files put those agreements in a header at the start, and many also compress the rest, so this lab\'s file would be neither the only nor the usual way to store a picture. But a broken header or a wrong row width does give you exactly what you just saw.',
};

export function paint(s: PictureState, row: number, col: number, rgb: number[]) {
  // Painting means the correct reading only: the same click under a wrong width would change bytes belonging to some other pixel, and that's a confusing lesson, not a useful one.
  if (!correct(s)) return false;
  const index = (row * s.width + col) * 3;
  if (index + 2 >= s.bytes.length) return false;
  const before = s.bytes.slice(index, index + 3);
  s.bytes.splice(index, 3, ...rgb);
  s.painted.push({ index, rgb, before });
  return true;
}

/** Changes how the bytes are read, and never the bytes. Returns an error and changes nothing if the width isn't usable. */
export function applySettings(s: PictureState, width: number, channels: 1 | 3, offset: number): string | null {
  if (!Number.isInteger(width) || width < 1 || width > 24) return 'The width has to be a whole number from 1 to 24. Nothing was redrawn.';
  s.width = width;
  s.channels = channels;
  s.offset = offset;
  s.seen.push({ width, channels, offset });
  return null;
}

/** What just happened, so the status line can say so. `none` claims nothing about the bytes. */
export type PictureChange = 'none' | 'settings' | 'refused' | 'painted';

/**
 * The status line. "The bytes have not changed" was once unconditional, so it appeared right
 * after a paint, above the three bytes that had just changed. Each sentence about the bytes
 * now belongs to the action it describes, and a paint is compared with the bytes it replaced.
 */
export function describePicture(s: PictureState, change: PictureChange): string {
  const g = layout(s.bytes, s.width, s.channels, s.offset);
  const lastRow = g.rows.at(-1)?.length ?? 0;
  const notes: string[] = [];
  if (lastRow && lastRow !== s.width) notes.push(`the last row is short, with ${lastRow} pixel${lastRow === 1 ? '' : 's'}`);
  if (g.leftover) notes.push(`${g.leftover} byte${g.leftover === 1 ? '' : 's'} left over`);
  const base = `${s.bytes.length} bytes read as ${g.pixels} pixels, ${s.width} wide and ${g.rows.length} tall${notes.length ? `: ${notes.join(', ')}` : ''}.`;
  const hexes = (b: number[]) => b.map(hex2).join(' ');
  if (change === 'settings') return `${base} That changed the reading, and not one byte.`;
  if (change === 'refused') return `${base} Nothing was painted, so not one byte changed.`;
  if (change === 'painted') {
    const p = s.painted.at(-1)!;
    if (p.before.every((b, i) => b === p.rgb[i])) return `${base} Those three bytes already held ${hexes(p.rgb)}, so no byte changed.`;
    return `${base} Painting wrote bytes ${p.index}, ${p.index + 1} and ${p.index + 2}: ${hexes(p.before)} became ${hexes(p.rgb)}. The other ${s.bytes.length - 3} bytes are as they were.`;
  }
  return base;
}
