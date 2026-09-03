import { createRequire } from 'node:module';

/** pdf.js 6 在模块加载时构造一份二维矩阵，即使只抽文本也会触发。
 * Node 不提供 DOMMatrix，canvas 又是可选依赖；用纯 JS 仿射矩阵补齐这一个入口。
 * 真正渲染时优先使用 canvas 原生实现；没有 canvas 的栅格器仍明确返回不可用。
 */
class AffineMatrix {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  constructor(values?: Iterable<number>) {
    if (values !== undefined) {
      const v = [...values];
      if (v.length !== 6) throw new TypeError('只支持二维仿射矩阵');
      [this.a, this.b, this.c, this.d, this.e, this.f] = v;
    }
  }
  multiplySelf(other: AffineMatrix): this {
    const { a, b, c, d, e, f } = this;
    this.a = a * other.a + c * other.b; this.b = b * other.a + d * other.b;
    this.c = a * other.c + c * other.d; this.d = b * other.c + d * other.d;
    this.e = a * other.e + c * other.f + e; this.f = b * other.e + d * other.f + f;
    return this;
  }
  multiply(other: AffineMatrix): AffineMatrix { return this.clone().multiplySelf(other); }
  translateSelf(x = 0, y = 0): this { return this.multiplySelf(new AffineMatrix([1, 0, 0, 1, x, y])); }
  scaleSelf(x = 1, y = x): this { return this.multiplySelf(new AffineMatrix([x, 0, 0, y, 0, 0])); }
  invertSelf(): this {
    const { a, b, c, d, e, f } = this, det = a * d - b * c;
    [this.a, this.b, this.c, this.d, this.e, this.f] = det === 0 ? Array(6).fill(NaN)
      : [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
    return this;
  }
  inverse(): AffineMatrix { return this.clone().invertSelf(); }
  private clone(): AffineMatrix { return new AffineMatrix([this.a, this.b, this.c, this.d, this.e, this.f]); }
}
if (typeof globalThis.DOMMatrix === 'undefined') {
  let matrix: unknown = AffineMatrix;
  try { matrix = createRequire(import.meta.url)('@napi-rs/canvas').DOMMatrix ?? AffineMatrix; } catch { /* 可选依赖缺席时只进行抽取。 */ }
  Reflect.set(globalThis, 'DOMMatrix', matrix);
}
