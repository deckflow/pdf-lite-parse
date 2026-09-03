export interface PdfName {
  kind: 'name';
  value: string;
}

export interface PdfRef {
  kind: 'ref';
  objectNumber: number;
  generation: number;
}

export interface PdfKeyword {
  kind: 'keyword';
  value: string;
}

export interface PdfString {
  kind: 'string';
  value: Buffer;
}

export type PdfDictionary = Map<string, PdfValue>;
export type PdfValue =
  | null
  | boolean
  | number
  | PdfName
  | PdfRef
  | PdfKeyword
  | PdfString
  | PdfValue[]
  | PdfDictionary;

const PDF_WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const PDF_DELIMITERS = new Set([
  0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25,
]);

export class PdfValueParser {
  readonly data: Buffer;
  position: number;

  constructor(data: Buffer, position = 0) {
    this.data = data;
    this.position = position;
  }

  skipSpace(): void {
    while (this.position < this.data.length) {
      const byte = this.data[this.position];
      if (PDF_WHITESPACE.has(byte)) {
        this.position += 1;
        continue;
      }
      if (byte === 0x25) {
        this.position += 1;
        while (this.position < this.data.length
          && this.data[this.position] !== 0x0a
          && this.data[this.position] !== 0x0d) {
          this.position += 1;
        }
        continue;
      }
      break;
    }
  }

  startsWith(text: string): boolean {
    return this.data.subarray(this.position, this.position + text.length).toString('latin1') === text;
  }

  consumeKeyword(keyword: string): boolean {
    this.skipSpace();
    if (!this.startsWith(keyword)) return false;
    const next = this.data[this.position + keyword.length];
    if (next !== undefined && !PDF_WHITESPACE.has(next) && !PDF_DELIMITERS.has(next)) {
      return false;
    }
    this.position += keyword.length;
    return true;
  }

  parseValue(): PdfValue {
    this.skipSpace();
    if (this.position >= this.data.length) throw new Error('PDF 对象意外结束');
    if (this.startsWith('<<')) return this.parseDictionary();
    if (this.data[this.position] === 0x5b) return this.parseArray();
    if (this.data[this.position] === 0x2f) return this.parseName();
    if (this.data[this.position] === 0x28) return this.parseLiteralString();
    if (this.data[this.position] === 0x3c) return this.parseHexString();
    if (this.consumeKeyword('true')) return true;
    if (this.consumeKeyword('false')) return false;
    if (this.consumeKeyword('null')) return null;

    const token = this.readToken();
    if (token.length === 0) throw new Error(`无法解析 PDF token，偏移 ${this.position}`);
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
      const firstNumber = Number(token);
      const afterFirst = this.position;
      if (Number.isInteger(firstNumber)) {
        this.skipSpace();
        const secondStart = this.position;
        const secondToken = this.readToken();
        if (/^\d+$/.test(secondToken) && this.consumeKeyword('R')) {
          return pdfRef(firstNumber, Number(secondToken));
        }
        this.position = secondStart;
      }
      this.position = afterFirst;
      return firstNumber;
    }
    return { kind: 'keyword', value: token };
  }

  parseDictionary(): PdfDictionary {
    this.position += 2;
    const dictionary: PdfDictionary = new Map();
    while (true) {
      this.skipSpace();
      if (this.startsWith('>>')) {
        this.position += 2;
        return dictionary;
      }
      if (this.position >= this.data.length) throw new Error('PDF 字典缺少 >>');
      const key = this.parseName();
      dictionary.set(key.value, this.parseValue());
    }
  }

  private parseArray(): PdfValue[] {
    this.position += 1;
    const values: PdfValue[] = [];
    while (true) {
      this.skipSpace();
      if (this.data[this.position] === 0x5d) {
        this.position += 1;
        return values;
      }
      if (this.position >= this.data.length) throw new Error('PDF 数组缺少 ]');
      values.push(this.parseValue());
    }
  }

  private parseName(): PdfName {
    this.skipSpace();
    if (this.data[this.position] !== 0x2f) throw new Error('PDF 字典键必须是 name');
    this.position += 1;
    const bytes: number[] = [];
    while (this.position < this.data.length) {
      const byte = this.data[this.position];
      if (PDF_WHITESPACE.has(byte) || PDF_DELIMITERS.has(byte)) break;
      const escaped = this.data.subarray(this.position + 1, this.position + 3).toString('latin1');
      if (byte === 0x23 && /^[0-9a-fA-F]{2}$/.test(escaped)) {
        bytes.push(Number.parseInt(escaped, 16));
        this.position += 3;
        continue;
      }
      bytes.push(byte);
      this.position += 1;
    }
    return pdfName(Buffer.from(bytes).toString('latin1'));
  }

  private parseLiteralString(): PdfString {
    this.position += 1;
    const bytes: number[] = [];
    let depth = 1;
    while (this.position < this.data.length && depth > 0) {
      let byte = this.data[this.position];
      this.position += 1;
      if (byte === 0x5c) {
        if (this.position >= this.data.length) break;
        byte = this.data[this.position];
        this.position += 1;
        const escaped = escapedByte(byte);
        if (escaped !== null) bytes.push(escaped);
        else if (byte === 0x0d || byte === 0x0a) {
          if (byte === 0x0d && this.data[this.position] === 0x0a) this.position += 1;
        } else if (byte >= 0x30 && byte <= 0x37) {
          let octal = String.fromCharCode(byte);
          for (let index = 0; index < 2; index += 1) {
            const next = this.data[this.position];
            if (next === undefined || next < 0x30 || next > 0x37) break;
            octal += String.fromCharCode(next);
            this.position += 1;
          }
          bytes.push(Number.parseInt(octal, 8));
        } else bytes.push(byte);
        continue;
      }
      if (byte === 0x28) depth += 1;
      if (byte === 0x29) depth -= 1;
      if (depth > 0) bytes.push(byte);
    }
    if (depth !== 0) throw new Error('PDF literal string 未闭合');
    return { kind: 'string', value: Buffer.from(bytes) };
  }

  private parseHexString(): PdfString {
    this.position += 1;
    const start = this.position;
    while (this.position < this.data.length && this.data[this.position] !== 0x3e) {
      this.position += 1;
    }
    if (this.position >= this.data.length) throw new Error('PDF hex string 缺少 >');
    const hex = this.data.subarray(start, this.position).toString('latin1').replaceAll(/\s/g, '');
    this.position += 1;
    if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('PDF hex string 含非法字符');
    return { kind: 'string', value: Buffer.from(hex.length % 2 === 0 ? hex : `${hex}0`, 'hex') };
  }

  readToken(): string {
    this.skipSpace();
    const start = this.position;
    while (this.position < this.data.length) {
      const byte = this.data[this.position];
      if (PDF_WHITESPACE.has(byte) || PDF_DELIMITERS.has(byte)) break;
      this.position += 1;
    }
    return this.data.subarray(start, this.position).toString('latin1');
  }
}

export function pdfName(value: string): PdfName {
  return { kind: 'name', value };
}

export function pdfRef(objectNumber: number, generation: number): PdfRef {
  return { kind: 'ref', objectNumber, generation };
}

export function isPdfName(value: PdfValue | undefined, expected?: string): value is PdfName {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'kind' in value && value.kind === 'name'
    && (expected === undefined || value.value === expected);
}

export function isPdfRef(value: PdfValue | undefined): value is PdfRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'kind' in value && value.kind === 'ref';
}

export function isPdfDictionary(value: PdfValue | undefined): value is PdfDictionary {
  return value instanceof Map;
}

export function pdfRefKey(value: PdfRef): string {
  return `${value.objectNumber} ${value.generation}`;
}

export function pdfNameValue(value: PdfValue | undefined): string | null {
  return isPdfName(value) ? value.value : null;
}

function escapedByte(byte: number): number | null {
  if (byte === 0x6e) return 0x0a;
  if (byte === 0x72) return 0x0d;
  if (byte === 0x74) return 0x09;
  if (byte === 0x62) return 0x08;
  if (byte === 0x66) return 0x0c;
  return null;
}
