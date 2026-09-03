import type { MissingField } from '../../schema/artifacts.ts';

export class MissingFieldError extends Error {
  readonly elementId: string;
  readonly field: string;
  readonly why: string;

  constructor(elementId: string, field: string, why: string) {
    super(`${elementId} 缺少字段 ${field}：${why}`);
    this.name = 'MissingFieldError';
    this.elementId = elementId;
    this.field = field;
    this.why = why;
  }
}

export interface FieldLocation {
  elementId: string;
  path: string;
}

export function requireField(
  record: Readonly<Record<string, unknown>>,
  field: string,
  location: FieldLocation,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, field) || record[field] === undefined) {
    throw new MissingFieldError(
      location.elementId,
      field,
      `${location.path}.${field} 是渲染所需字段`,
    );
  }
  return record[field];
}

export function toMissingField(error: MissingFieldError, path: string): MissingField {
  return {
    path,
    field: error.field,
    elementId: error.elementId,
    message: error.message,
  };
}
