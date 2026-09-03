import { inflateSync } from 'node:zlib';
import {
  L0_MAX_OBJECT_STREAM_OBJECTS,
  L0_MAX_REFERENCE_DEPTH,
  L0_MAX_STRUCTURAL_OBJECTS,
  L0_MAX_XREF_SECTIONS,
} from '../../params/l0.ts';
import {
  isPdfDictionary,
  isPdfName,
  isPdfRef,
  PdfValueParser,
  pdfRef,
  pdfRefKey,
  type PdfDictionary,
  type PdfRef,
  type PdfValue,
} from './value-parser.ts';

interface RegularXrefEntry {
  type: 1;
  offset: number;
  generation: number;
}

interface CompressedXrefEntry {
  type: 2;
  objectStream: number;
  index: number;
}

type XrefEntry = RegularXrefEntry | CompressedXrefEntry;

export interface PdfObjectRecord {
  objectNumber: number;
  generation: number;
  value: PdfValue;
  stream: Buffer | null;
  compressed: boolean;
}

export interface ObjectStoreBuild {
  store: PdfObjectStore;
  trailer: PdfDictionary | null;
  xrefAvailable: boolean;
  issues: string[];
}

interface ParsedXrefSection {
  entries: Map<string, XrefEntry>;
  trailer: PdfDictionary;
  linkedOffsets: number[];
}

export class PdfObjectStore {
  readonly data: Buffer;
  private readonly entries: Map<string, XrefEntry>;
  private readonly records = new Map<string, PdfObjectRecord>();
  private readonly loading = new Set<string>();

  constructor(data: Buffer, entries: Map<string, XrefEntry>) {
    this.data = data;
    this.entries = entries;
  }

  addFallbackOffsets(): number {
    const source = this.data.toString('latin1');
    const pattern = /(\d+)\s+(\d+)\s+obj\b/g;
    let count = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (count >= L0_MAX_STRUCTURAL_OBJECTS) throw new Error('间接对象数量超过 L0 安全上限');
      const objectNumber = Number(match[1]);
      const generation = Number(match[2]);
      const key = pdfRefKey(pdfRef(objectNumber, generation));
      if (!this.entries.has(key)) {
        this.entries.set(key, { type: 1, offset: match.index, generation });
      }
      count += 1;
    }
    return count;
  }

  resolve(value: PdfValue | undefined): PdfValue {
    if (value === undefined) throw new Error('缺少 PDF 值');
    const visited = new Set<string>();
    let current = value;
    while (isPdfRef(current)) {
      const key = pdfRefKey(current);
      if (visited.size >= L0_MAX_REFERENCE_DEPTH) throw new Error('间接引用深度超过 L0 安全上限');
      if (visited.has(key)) throw new Error(`间接引用形成环：${key} R`);
      visited.add(key);
      current = this.getRecord(current).value;
    }
    return current;
  }

  resolveDictionary(value: PdfValue | undefined): PdfDictionary {
    const resolved = this.resolve(value);
    if (!isPdfDictionary(resolved)) throw new Error('PDF 值不是字典');
    return resolved;
  }

  getRecord(reference: PdfRef): PdfObjectRecord {
    const key = pdfRefKey(reference);
    const existing = this.records.get(key);
    if (existing) return existing;
    if (this.loading.has(key)) throw new Error(`间接对象加载成环：${key} R`);
    const entry = this.entries.get(key)
      ?? (reference.generation === 0 ? this.entries.get(`${reference.objectNumber} 0`) : undefined);
    if (!entry) throw new Error(`xref 缺少间接对象：${key} R`);
    this.loading.add(key);
    try {
      if (entry.type === 1) {
        const record = parseIndirectObjectAt(this.data, entry.offset);
        this.records.set(pdfRefKey(pdfRef(record.objectNumber, record.generation)), record);
        if (record.objectNumber !== reference.objectNumber) {
          throw new Error(`xref 偏移指向对象 ${record.objectNumber}，期望 ${reference.objectNumber}`);
        }
        return record;
      }
      this.expandObjectStream(entry.objectStream);
      const compressed = this.records.get(`${reference.objectNumber} 0`);
      if (!compressed) throw new Error(`对象流未产出对象 ${reference.objectNumber}`);
      return compressed;
    } finally {
      this.loading.delete(key);
    }
  }

  decodeRecordStream(record: PdfObjectRecord): Buffer {
    return decodeStream(record, (value) => this.resolve(value));
  }

  findDictionaryByType(type: string): PdfDictionary | null {
    let visited = 0;
    for (const [key] of this.entries) {
      if (visited >= L0_MAX_STRUCTURAL_OBJECTS) throw new Error('对象遍历超过 L0 安全上限');
      visited += 1;
      const [objectNumber, generation] = key.split(' ').map(Number);
      try {
        const value = this.getRecord(pdfRef(objectNumber, generation)).value;
        if (isPdfDictionary(value) && isPdfName(value.get('Type'), type)) return value;
      } catch {
        // 找 Catalog 的恢复扫描允许单个坏对象缺席；调用方会把 xref 降级写入 warning。
      }
    }
    return null;
  }

  private expandObjectStream(objectStreamNumber: number): void {
    const streamRef = pdfRef(objectStreamNumber, 0);
    const streamRecord = this.getRecord(streamRef);
    const dictionary = streamRecord.value;
    if (!isPdfDictionary(dictionary)) throw new Error(`/ObjStm ${objectStreamNumber} 不是字典`);
    const objectCount = resolvedInteger(dictionary.get('N'), (value) => this.resolve(value));
    const firstOffset = resolvedInteger(dictionary.get('First'), (value) => this.resolve(value));
    if (objectCount < 0 || objectCount > L0_MAX_OBJECT_STREAM_OBJECTS || firstOffset < 0) {
      throw new Error(`/ObjStm ${objectStreamNumber} 的 /N 或 /First 非法`);
    }
    const decoded = this.decodeRecordStream(streamRecord);
    const header = new PdfValueParser(decoded);
    const entries: Array<{ objectNumber: number; offset: number }> = [];
    for (let index = 0; index < objectCount; index += 1) {
      const objectNumber = header.parseValue();
      const offset = header.parseValue();
      if (!isPdfInteger(objectNumber) || !isPdfInteger(offset)) {
        throw new Error(`/ObjStm ${objectStreamNumber} 对象头非法`);
      }
      entries.push({ objectNumber, offset });
    }
    if (header.position > firstOffset) throw new Error(`/ObjStm ${objectStreamNumber} 的 /First 过小`);
    for (const entry of entries) {
      const key = `${entry.objectNumber} 0`;
      if (this.records.has(key)) continue;
      const parser = new PdfValueParser(decoded, firstOffset + entry.offset);
      this.records.set(key, {
        objectNumber: entry.objectNumber,
        generation: 0,
        value: parser.parseValue(),
        stream: null,
        compressed: true,
      });
    }
  }
}

export function buildObjectStore(input: Uint8Array): ObjectStoreBuild {
  const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const issues: string[] = [];
  let trailer: PdfDictionary | null = null;
  let xrefAvailable = false;
  let entries = new Map<string, XrefEntry>();
  try {
    const crossReference = readCrossReference(data);
    entries = crossReference.entries;
    trailer = crossReference.trailer;
    xrefAvailable = true;
  } catch (error) {
    issues.push(`xref 无法读取：${errorMessage(error)}`);
    trailer = findFallbackTrailer(data);
  }
  const store = new PdfObjectStore(data, entries);
  try {
    const found = store.addFallbackOffsets();
    if (found === 0 && entries.size === 0) issues.push('没有找到任何间接对象');
  } catch (error) {
    issues.push(`间接对象恢复扫描失败：${errorMessage(error)}`);
  }
  return { store, trailer, xrefAvailable, issues };
}

function readCrossReference(data: Buffer): { entries: Map<string, XrefEntry>; trailer: PdfDictionary } {
  const startOffset = findStartXref(data);
  const queue = [startOffset];
  const visited = new Set<number>();
  const entries = new Map<string, XrefEntry>();
  let newestTrailer: PdfDictionary | null = null;
  while (queue.length > 0) {
    if (visited.size >= L0_MAX_XREF_SECTIONS) throw new Error('xref 链超过 L0 安全上限');
    const offset = queue.shift();
    if (offset === undefined || visited.has(offset)) continue;
    if (!Number.isInteger(offset) || offset < 0 || offset >= data.length) {
      throw new Error(`xref 偏移越界：${String(offset)}`);
    }
    visited.add(offset);
    const section = parseXrefSection(data, offset);
    if (newestTrailer === null) newestTrailer = section.trailer;
    for (const [key, entry] of section.entries) {
      // 从最新修订向 /Prev 遍历，较旧条目不能覆盖较新的版本。
      if (!entries.has(key)) entries.set(key, entry);
    }
    queue.push(...section.linkedOffsets);
  }
  if (newestTrailer === null) throw new Error('xref 没有 trailer');
  return { entries, trailer: newestTrailer };
}

function findStartXref(data: Buffer): number {
  const tail = data.subarray(Math.max(0, data.length - 4096)).toString('latin1');
  const pattern = /startxref\s+(\d+)/g;
  let found: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tail)) !== null) found = Number(match[1]);
  if (found === null) throw new Error('缺少 startxref');
  return found;
}

function parseXrefSection(data: Buffer, offset: number): ParsedXrefSection {
  const parser = new PdfValueParser(data, offset);
  parser.skipSpace();
  if (parser.consumeKeyword('xref')) return parseClassicXref(parser);
  return parseXrefStream(data, offset);
}

function parseClassicXref(parser: PdfValueParser): ParsedXrefSection {
  const entries = new Map<string, XrefEntry>();
  while (true) {
    parser.skipSpace();
    if (parser.consumeKeyword('trailer')) {
      const trailer = parser.parseValue();
      if (!isPdfDictionary(trailer)) throw new Error('trailer 不是字典');
      return { entries, trailer, linkedOffsets: linkedXrefOffsets(trailer) };
    }
    const firstObject = parser.parseValue();
    const count = parser.parseValue();
    if (!isPdfInteger(firstObject) || !isPdfInteger(count)
      || firstObject < 0 || count < 0 || count > L0_MAX_STRUCTURAL_OBJECTS) {
      throw new Error('xref subsection 头非法');
    }
    for (let index = 0; index < count; index += 1) {
      const objectOffset = parser.parseValue();
      const generation = parser.parseValue();
      const state = parser.parseValue();
      if (!isPdfInteger(objectOffset) || !isPdfInteger(generation) || !isKeyword(state)) {
        throw new Error('xref entry 非法');
      }
      if (state.value === 'n') {
        entries.set(`${firstObject + index} ${generation}`, {
          type: 1,
          offset: objectOffset,
          generation,
        });
      }
    }
  }
}

function parseXrefStream(data: Buffer, offset: number): ParsedXrefSection {
  const record = parseIndirectObjectAt(data, offset);
  if (!isPdfDictionary(record.value)) throw new Error('xref stream 对象不是字典');
  const dictionary = record.value;
  const widths = numericArray(dictionary.get('W'));
  if (widths.length !== 3 || widths.some((width) => width < 0 || width > 8)) {
    throw new Error('xref stream /W 非法');
  }
  const size = directInteger(dictionary.get('Size'));
  const ranges = dictionary.has('Index') ? numericArray(dictionary.get('Index')) : [0, size];
  if (ranges.length % 2 !== 0) throw new Error('xref stream /Index 非法');
  const decoded = decodeStream(record, directResolve);
  const rowWidth = widths[0] + widths[1] + widths[2];
  if (rowWidth <= 0) throw new Error('xref stream entry 宽度为 0');
  const entries = new Map<string, XrefEntry>();
  let cursor = 0;
  for (let range = 0; range < ranges.length; range += 2) {
    const firstObject = ranges[range];
    const count = ranges[range + 1];
    if (!Number.isInteger(firstObject) || !Number.isInteger(count)
      || firstObject < 0 || count < 0 || count > L0_MAX_STRUCTURAL_OBJECTS) {
      throw new Error('xref stream /Index 范围非法');
    }
    for (let index = 0; index < count; index += 1) {
      if (cursor + rowWidth > decoded.length) throw new Error('xref stream 数据截断');
      const type = widths[0] === 0 ? 1 : readBigEndian(decoded, cursor, widths[0]);
      cursor += widths[0];
      const field2 = readBigEndian(decoded, cursor, widths[1]);
      cursor += widths[1];
      const field3 = readBigEndian(decoded, cursor, widths[2]);
      cursor += widths[2];
      const objectNumber = firstObject + index;
      if (type === 1) {
        entries.set(`${objectNumber} ${field3}`, { type: 1, offset: field2, generation: field3 });
      } else if (type === 2) {
        entries.set(`${objectNumber} 0`, { type: 2, objectStream: field2, index: field3 });
      }
    }
  }
  return { entries, trailer: dictionary, linkedOffsets: linkedXrefOffsets(dictionary) };
}

function linkedXrefOffsets(trailer: PdfDictionary): number[] {
  const offsets: number[] = [];
  for (const key of ['XRefStm', 'Prev']) {
    const value = trailer.get(key);
    if (isPdfInteger(value) && value >= 0) offsets.push(value);
  }
  return offsets;
}

function findFallbackTrailer(data: Buffer): PdfDictionary | null {
  const marker = Buffer.from('trailer', 'latin1');
  let offset = data.lastIndexOf(marker);
  while (offset >= 0) {
    try {
      const parser = new PdfValueParser(data, offset + marker.length);
      const value = parser.parseValue();
      if (isPdfDictionary(value)) return value;
    } catch {
      // 继续找更早的 trailer，增量保存的最后一段可能恰好损坏。
    }
    offset = data.lastIndexOf(marker, offset - 1);
  }
  return null;
}

function parseIndirectObjectAt(data: Buffer, offset: number): PdfObjectRecord {
  const parser = new PdfValueParser(data, offset);
  const objectNumber = parser.parseValue();
  const generation = parser.parseValue();
  if (!isPdfInteger(objectNumber) || !isPdfInteger(generation) || !parser.consumeKeyword('obj')) {
    throw new Error(`偏移 ${offset} 不是间接对象头`);
  }
  const value = parser.parseValue();
  const bounds = isPdfDictionary(value) ? streamBounds(data, parser, value) : null;
  return {
    objectNumber,
    generation,
    value,
    stream: bounds === null ? null : data.subarray(bounds.start, bounds.end),
    compressed: false,
  };
}

function streamBounds(
  data: Buffer,
  parser: PdfValueParser,
  dictionary: PdfDictionary,
): { start: number; end: number } | null {
  parser.skipSpace();
  if (!parser.consumeKeyword('stream')) return null;
  if (data[parser.position] === 0x0d) parser.position += 1;
  if (data[parser.position] === 0x0a) parser.position += 1;
  const start = parser.position;
  const declaredLength = dictionary.get('Length');
  if (isPdfInteger(declaredLength) && declaredLength >= 0 && start + declaredLength <= data.length) {
    return { start, end: start + declaredLength };
  }
  const marker = data.indexOf(Buffer.from('endstream', 'latin1'), start);
  if (marker < 0) throw new Error('PDF stream 缺少 endstream');
  let end = marker;
  if (data[end - 1] === 0x0a) end -= 1;
  if (data[end - 1] === 0x0d) end -= 1;
  return { start, end };
}

function decodeStream(record: PdfObjectRecord, resolve: (value: PdfValue) => PdfValue): Buffer {
  if (record.stream === null) throw new Error(`对象 ${record.objectNumber} 没有 stream`);
  if (!isPdfDictionary(record.value)) throw new Error(`对象 ${record.objectNumber} 的 stream 没有字典`);
  let decoded: Buffer = Buffer.from(record.stream);
  const rawFilter = record.value.get('Filter');
  if (rawFilter === undefined) return decoded;
  const resolvedFilter = resolve(rawFilter);
  const filters = Array.isArray(resolvedFilter) ? resolvedFilter : [resolvedFilter];
  const rawParameters = record.value.get('DecodeParms');
  const resolvedParameters = rawParameters === undefined ? [] : resolve(rawParameters);
  const parameters = Array.isArray(resolvedParameters) ? resolvedParameters : [resolvedParameters];
  for (let index = 0; index < filters.length; index += 1) {
    const filter = resolve(filters[index]);
    if (!isPdfName(filter)) throw new Error(`对象 ${record.objectNumber} 的 /Filter 不是 name`);
    if (filter.value === 'FlateDecode' || filter.value === 'Fl') {
      decoded = inflateSync(decoded);
      decoded = applyPredictor(decoded, parameters[index], resolve);
    } else if (filter.value === 'ASCIIHexDecode' || filter.value === 'AHx') {
      decoded = decodeAsciiHex(decoded);
    } else if (filter.value === 'ASCII85Decode' || filter.value === 'A85') {
      decoded = decodeAscii85(decoded);
    } else if (filter.value === 'RunLengthDecode' || filter.value === 'RL') {
      decoded = decodeRunLength(decoded);
    } else {
      throw new Error(`对象 ${record.objectNumber} 使用不支持的 stream filter：${filter.value}`);
    }
  }
  return decoded;
}

function applyPredictor(
  data: Buffer,
  rawParameters: PdfValue | undefined,
  resolve: (value: PdfValue) => PdfValue,
): Buffer {
  if (rawParameters === undefined || rawParameters === null) return data;
  const parameters = resolve(rawParameters);
  if (!isPdfDictionary(parameters)) return data;
  const predictor = optionalInteger(parameters.get('Predictor'), 1);
  if (predictor === 1) return data;
  const colors = optionalInteger(parameters.get('Colors'), 1);
  const bits = optionalInteger(parameters.get('BitsPerComponent'), 8);
  const columns = optionalInteger(parameters.get('Columns'), 1);
  if (predictor < 10 || predictor > 15 || colors <= 0 || bits <= 0 || columns <= 0) {
    throw new Error(`不支持的 stream predictor：${predictor}`);
  }
  const rowBytes = Math.ceil(colors * columns * bits / 8);
  const bytesPerPixel = Math.max(1, Math.ceil(colors * bits / 8));
  if (data.length % (rowBytes + 1) !== 0) throw new Error('PNG predictor 行长度非法');
  const output = Buffer.alloc(data.length / (rowBytes + 1) * rowBytes);
  let inputOffset = 0;
  let outputOffset = 0;
  while (inputOffset < data.length) {
    const filter = data[inputOffset];
    inputOffset += 1;
    for (let column = 0; column < rowBytes; column += 1) {
      const raw = data[inputOffset + column];
      const left = column >= bytesPerPixel ? output[outputOffset + column - bytesPerPixel] : 0;
      const up = outputOffset >= rowBytes ? output[outputOffset + column - rowBytes] : 0;
      const upperLeft = outputOffset >= rowBytes && column >= bytesPerPixel
        ? output[outputOffset + column - rowBytes - bytesPerPixel]
        : 0;
      output[outputOffset + column] = predictedByte(filter, raw, left, up, upperLeft);
    }
    inputOffset += rowBytes;
    outputOffset += rowBytes;
  }
  return output;
}

function predictedByte(filter: number, raw: number, left: number, up: number, upperLeft: number): number {
  if (filter === 0) return raw;
  if (filter === 1) return (raw + left) & 0xff;
  if (filter === 2) return (raw + up) & 0xff;
  if (filter === 3) return (raw + Math.floor((left + up) / 2)) & 0xff;
  if (filter === 4) return (raw + paeth(left, up, upperLeft)) & 0xff;
  throw new Error(`未知 PNG predictor filter：${filter}`);
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function decodeAsciiHex(data: Buffer): Buffer {
  const text = data.toString('latin1').replaceAll(/\s/g, '').replace(/>.*$/s, '');
  if (!/^[0-9a-fA-F]*$/.test(text)) throw new Error('ASCIIHexDecode 含非法字符');
  return Buffer.from(text.length % 2 === 0 ? text : `${text}0`, 'hex');
}

function decodeAscii85(data: Buffer): Buffer {
  const text = data.toString('latin1').replaceAll(/\s/g, '').replace(/^<~/, '').replace(/~>.*$/s, '');
  const output: number[] = [];
  let group: number[] = [];
  for (const character of text) {
    if (character === 'z') {
      if (group.length !== 0) throw new Error('ASCII85 的 z 出现在分组中');
      output.push(0, 0, 0, 0);
      continue;
    }
    const value = character.charCodeAt(0) - 33;
    if (value < 0 || value > 84) throw new Error('ASCII85Decode 含非法字符');
    group.push(value);
    if (group.length === 5) {
      output.push(...ascii85Group(group, 4));
      group = [];
    }
  }
  if (group.length === 1) throw new Error('ASCII85Decode 尾组长度非法');
  if (group.length > 1) {
    const outputBytes = group.length - 1;
    while (group.length < 5) group.push(84);
    output.push(...ascii85Group(group, outputBytes));
  }
  return Buffer.from(output);
}

function ascii85Group(group: readonly number[], outputBytes: number): number[] {
  let value = 0;
  for (const digit of group) value = value * 85 + digit;
  const bytes = [value >>> 24, value >>> 16, value >>> 8, value].map((byte) => byte & 0xff);
  return bytes.slice(0, outputBytes);
}

function decodeRunLength(data: Buffer): Buffer {
  const output: number[] = [];
  let cursor = 0;
  while (cursor < data.length) {
    const length = data[cursor];
    cursor += 1;
    if (length === 128) break;
    if (length < 128) {
      const count = length + 1;
      if (cursor + count > data.length) throw new Error('RunLengthDecode 数据截断');
      output.push(...data.subarray(cursor, cursor + count));
      cursor += count;
    } else {
      if (cursor >= data.length) throw new Error('RunLengthDecode 重复字节缺失');
      const count = 257 - length;
      for (let index = 0; index < count; index += 1) output.push(data[cursor]);
      cursor += 1;
    }
  }
  return Buffer.from(output);
}

function readBigEndian(data: Buffer, offset: number, width: number): number {
  let value = 0;
  for (let index = 0; index < width; index += 1) value = value * 256 + data[offset + index];
  if (!Number.isSafeInteger(value)) throw new Error('xref stream 字段超过安全整数范围');
  return value;
}

function numericArray(value: PdfValue | undefined): number[] {
  if (!Array.isArray(value) || !value.every(Number.isInteger)) throw new Error('PDF 值不是整数数组');
  return value as number[];
}

function directInteger(value: PdfValue | undefined): number {
  if (!isPdfInteger(value)) throw new Error('PDF 值不是整数');
  return value;
}

function optionalInteger(value: PdfValue | undefined, fallback: number): number {
  return value === undefined ? fallback : directInteger(value);
}

function resolvedInteger(value: PdfValue | undefined, resolve: (value: PdfValue) => PdfValue): number {
  if (value === undefined) throw new Error('缺少 PDF 整数');
  return directInteger(resolve(value));
}

function directResolve(value: PdfValue): PdfValue {
  if (isPdfRef(value)) throw new Error('xref stream 的解码参数不能在 xref 建立前间接引用');
  return value;
}

function isKeyword(value: PdfValue): value is { kind: 'keyword'; value: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'kind' in value && value.kind === 'keyword';
}

function isPdfInteger(value: PdfValue | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
