import type { MissingField } from '../../schema/artifacts.ts';
import { ARTIFACT_SCHEMA_VERSIONS } from '../../schema/artifacts.ts';
import {
  MissingFieldError,
  requireField,
  toMissingField,
  type FieldLocation,
} from './strict.ts';

type JsonObject = Record<string, unknown>;

const ABSENT = Symbol('render.absent');
const MISSING = Symbol('render.missing');

class Auditor {
  readonly missingFields: MissingField[] = [];

  required(record: JsonObject, field: string, location: FieldLocation): unknown | typeof MISSING {
    try {
      return requireField(record, field, location);
    } catch (error) {
      if (!(error instanceof MissingFieldError)) throw error;
      this.missingFields.push(toMissingField(error, `${location.path}.${field}`));
      return MISSING;
    }
  }

  optional(record: JsonObject, field: string): unknown | typeof ABSENT {
    if (!Object.prototype.hasOwnProperty.call(record, field) || record[field] === undefined) {
      return ABSENT;
    }
    return record[field];
  }

  requiredObject(
    record: JsonObject,
    field: string,
    location: FieldLocation,
  ): JsonObject | undefined {
    const value = this.required(record, field, location);
    if (value === MISSING) return undefined;
    return asObject(value, `${location.path}.${field}`);
  }

  requiredArray(
    record: JsonObject,
    field: string,
    location: FieldLocation,
  ): unknown[] | undefined {
    const value = this.required(record, field, location);
    if (value === MISSING) return undefined;
    return asArray(value, `${location.path}.${field}`);
  }

  recordAnchorMissing(location: FieldLocation): void {
    const error = new MissingFieldError(
      location.elementId,
      'sourceObjectIds',
      `${location.path} 必须提供 sourceObjectIds 或 sourceRasters 作为溯源锚`,
    );
    this.missingFields.push(toMissingField(error, `${location.path}.sourceObjectIds`));
  }
}

export function auditDocument(input: unknown): MissingField[] {
  const auditor = new Auditor();
  const document = asObject(input, 'document');
  const documentLocation = location('<document>', 'document');
  const schemaVersion = auditor.required(document, 'schemaVersion', documentLocation);
  const isResult = schemaVersion === ARTIFACT_SCHEMA_VERSIONS.result;

  auditSource(auditor, document, documentLocation, isResult);
  auditDocInfo(auditor, document, documentLocation);
  auditOutline(auditor, document, documentLocation);
  auditPages(auditor, document, documentLocation, isResult);
  auditElementArray(auditor, document, 'elements', documentLocation);
  auditAnnotations(auditor, document, documentLocation);

  const furniture = auditor.optional(document, 'furniture');
  if (furniture !== ABSENT) {
    auditElements(auditor, asArray(furniture, 'document.furniture'), 'document.furniture');
  }

  if (isResult) auditResultFields(auditor, document, documentLocation);
  return auditor.missingFields;
}

function auditDocInfo(
  auditor: Auditor,
  document: JsonObject,
  documentLocation: FieldLocation,
): void {
  const docInfo = auditor.requiredObject(document, 'docInfo', documentLocation);
  if (!docInfo) return;
  auditFields(auditor, docInfo, location('<document>', 'document.docInfo'), [
    'status',
    'title',
    'author',
    'subject',
    'keywords',
    'creator',
    'producer',
    'createdAt',
    'modifiedAt',
    'lang',
  ]);
}

/** null 是合法值（这份 PDF 没有大纲），但字段本身必须在：缺字段等于没说。 */
function auditOutline(
  auditor: Auditor,
  document: JsonObject,
  documentLocation: FieldLocation,
): void {
  const outline = auditor.required(document, 'outline', documentLocation);
  if (outline === MISSING || outline === null) return;
  auditOutlineNodes(auditor, asArray(outline, 'document.outline'), 'document.outline');
}

function auditOutlineNodes(auditor: Auditor, nodes: unknown[], basePath: string): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const nodePath = `${basePath}[${index}]`;
    const node = asObject(nodes[index], nodePath);
    const nodeLocation = location('<outline>', nodePath);
    auditFields(auditor, node, nodeLocation, ['title', 'children']);
    const target = auditor.required(node, 'target', nodeLocation);
    if (target !== MISSING && target !== null) {
      auditLinkTarget(auditor, asObject(target, `${nodePath}.target`), nodeLocation);
    }
    const children = auditor.optional(node, 'children');
    if (children !== ABSENT) {
      auditOutlineNodes(auditor, asArray(children, `${nodePath}.children`), `${nodePath}.children`);
    }
  }
}

function auditAnnotations(
  auditor: Auditor,
  document: JsonObject,
  documentLocation: FieldLocation,
): void {
  const annotations = auditor.requiredArray(document, 'annotations', documentLocation);
  if (!annotations) return;
  for (let index = 0; index < annotations.length; index += 1) {
    const annotationPath = `document.annotations[${index}]`;
    const annotation = asObject(annotations[index], annotationPath);
    const annotationLocation = location(
      stringHint(annotation.id, `<annotation:${index}>`),
      annotationPath,
    );
    auditFields(auditor, annotation, annotationLocation, [
      'id',
      'page',
      'bbox',
      'subtype',
      'contents',
      'sourceObjectIds',
    ]);
    const target = auditor.required(annotation, 'target', annotationLocation);
    if (target !== MISSING && target !== null) {
      auditLinkTarget(auditor, asObject(target, `${annotationPath}.target`), annotationLocation);
    }
  }
}

/** 判别联合的两支各有各的必填项，按 kind 分开查，不能只查交集。 */
function auditLinkTarget(
  auditor: Auditor,
  target: JsonObject,
  ownerLocation: FieldLocation,
): void {
  const targetLocation = location(ownerLocation.elementId, `${ownerLocation.path}.target`);
  const kind = auditor.required(target, 'kind', targetLocation);
  if (kind === 'external') auditor.required(target, 'href', targetLocation);
  else if (kind === 'internal') auditFields(auditor, target, targetLocation, ['page', 'destination']);
  else if (kind !== MISSING) {
    throw new TypeError(`${targetLocation.path}.kind 不是受支持的跳转类型：${String(kind)}`);
  }
}

function auditSource(
  auditor: Auditor,
  document: JsonObject,
  documentLocation: FieldLocation,
  isResult: boolean,
): void {
  const source = auditor.requiredObject(document, 'source', documentLocation);
  if (!source) return;
  const sourceLocation = location('<document>', 'document.source');
  auditFields(auditor, source, sourceLocation, ['sha256', 'pages', 'encrypted']);
  if (isResult) auditor.optional(source, 'path');
}

function auditPages(
  auditor: Auditor,
  document: JsonObject,
  documentLocation: FieldLocation,
  isResult: boolean,
): void {
  const pages = auditor.requiredArray(document, 'pages', documentLocation);
  if (!pages) return;
  for (let index = 0; index < pages.length; index += 1) {
    const pagePath = `document.pages[${index}]`;
    const page = asObject(pages[index], pagePath);
    const pageNumber = stringHint(page.index, `<page:${index}>`);
    const pageLocation = location(pageNumber, pagePath);
    auditFields(
      auditor,
      page,
      pageLocation,
      ['index', 'width', 'height', 'rotation', 'status', 'sourceObjectCoverage'],
    );
    if (isResult) auditResultPage(auditor, page, pageLocation);
  }
}

function auditResultPage(auditor: Auditor, page: JsonObject, pageLocation: FieldLocation): void {
  const probe = auditor.requiredObject(page, 'probe', pageLocation);
  if (probe) {
    auditFields(auditor, probe, location(pageLocation.elementId, `${pageLocation.path}.probe`), [
      'layoutType',
      'textLayerVerdict',
      'hasBrokenTextLayer',
      'hasOverlaidTextOnImage',
      'textDensity',
      'columns',
      'imageAreaRatio',
      'hasTable',
      'tableKind',
      'hasFormula',
      'hasChart',
      'hasRotatedText',
      'riskLevel',
      'structuralUncertainty',
      'recommendedEngines',
    ]);
  }

  const route = auditor.requiredObject(page, 'route', pageLocation);
  if (route) {
    const routeLocation = location(pageLocation.elementId, `${pageLocation.path}.route`);
    auditFields(auditor, route, routeLocation, [
      'disposition',
      'planned',
      'actual',
      'fallbackFrom',
      'oracleAccepted',
      'reason',
    ]);
    const plan = auditor.requiredObject(route, 'plan', routeLocation);
    if (plan) {
      auditFields(
        auditor,
        plan,
        location(pageLocation.elementId, `${routeLocation.path}.plan`),
        ['role', 'tier'],
      );
    }
  }

  const cost = auditor.requiredObject(page, 'cost', pageLocation);
  if (cost) {
    auditFields(
      auditor,
      cost,
      location(pageLocation.elementId, `${pageLocation.path}.cost`),
      ['ms', 'inputTokens', 'outputTokens', 'usd'],
    );
  }
}

function auditResultFields(
  auditor: Auditor,
  document: JsonObject,
  documentLocation: FieldLocation,
): void {
  auditFields(auditor, document, documentLocation, ['version', 'profile']);

  const warnings = auditor.requiredArray(document, 'warnings', documentLocation);
  if (warnings) {
    for (let index = 0; index < warnings.length; index += 1) {
      const warningPath = `document.warnings[${index}]`;
      const warning = asObject(warnings[index], warningPath);
      const warningLocation = location('<document>', warningPath);
      const scope = auditor.required(warning, 'scope', warningLocation);
      auditFields(auditor, warning, warningLocation, ['code', 'severity', 'message']);
      if (scope === 'page' || scope === 'element') {
        auditor.required(warning, 'page', warningLocation);
      }
      if (scope === 'element') auditor.required(warning, 'elementId', warningLocation);
      auditor.optional(warning, 'detail');
    }
  }

  const stats = auditor.requiredObject(document, 'stats', documentLocation);
  if (stats) {
    auditFields(auditor, stats, location('<document>', 'document.stats'), [
      'totalMs',
      'byEngine',
      'usd',
      'weakAnchorShare',
    ]);
  }
}

function auditElementArray(
  auditor: Auditor,
  owner: JsonObject,
  field: string,
  ownerLocation: FieldLocation,
): void {
  const elements = auditor.requiredArray(owner, field, ownerLocation);
  if (elements) auditElements(auditor, elements, `${ownerLocation.path}.${field}`);
}

function auditElements(auditor: Auditor, values: unknown[], basePath: string): void {
  for (let index = 0; index < values.length; index += 1) {
    const elementPath = `${basePath}[${index}]`;
    const element = asObject(values[index], elementPath);
    auditElement(auditor, element, elementPath, index);
  }
}

function auditElement(
  auditor: Auditor,
  element: JsonObject,
  elementPath: string,
  index: number,
): void {
  const elementId = stringHint(element.id, `<element:${index}>`);
  const elementLocation = location(elementId, elementPath);
  const type = auditor.required(element, 'type', elementLocation);
  auditFields(auditor, element, elementLocation, [
    'id',
    'page',
    'order',
    'text',
    'bbox',
    'parentId',
    'confidence',
    'isBodyContent',
  ]);

  auditMarks(auditor, element, elementLocation);
  auditStyle(auditor, element, elementLocation);
  auditBboxes(auditor, element, elementLocation);
  auditor.optional(element, 'continuesFrom');
  auditAnchors(auditor, element, elementLocation);
  auditProvenance(auditor, element, elementLocation);

  if (type === MISSING) return;
  switch (type) {
    case 'unknown':
      break;
    case 'heading':
      auditor.required(element, 'level', elementLocation);
      break;
    case 'paragraph':
    case 'footnote':
      break;
    case 'list':
      auditList(auditor, element, elementLocation);
      break;
    case 'list_item':
      auditFields(auditor, element, elementLocation, ['marker', 'depth']);
      break;
    case 'table':
      auditTable(auditor, element, elementLocation);
      break;
    case 'figure':
    case 'chart':
      auditFigure(auditor, element, elementLocation);
      break;
    case 'caption':
      auditor.required(element, 'captionOf', elementLocation);
      break;
    case 'formula':
      auditFormula(auditor, element, elementLocation);
      break;
    case 'code':
      auditCode(auditor, element, elementLocation);
      break;
    case 'header':
    case 'footer':
    case 'gutter':
    case 'watermark':
    case 'page_number':
    case 'stamp':
      auditor.required(element, 'furnitureKind', elementLocation);
      break;
    default:
      throw new TypeError(`${elementPath}.type 不是受支持的元素类型：${String(type)}`);
  }
}

function auditMarks(auditor: Auditor, element: JsonObject, elementLocation: FieldLocation): void {
  const marks = auditor.optional(element, 'marks');
  if (marks === ABSENT) return;
  const markValues = asArray(marks, `${elementLocation.path}.marks`);
  for (let index = 0; index < markValues.length; index += 1) {
    const markPath = `${elementLocation.path}.marks[${index}]`;
    const mark = asObject(markValues[index], markPath);
    const markLocation = location(elementLocation.elementId, markPath);
    const type = auditor.required(mark, 'type', markLocation);
    auditFields(auditor, mark, markLocation, ['start', 'end']);
    if (type !== 'link') continue;
    const target = auditor.required(mark, 'target', markLocation);
    if (target === MISSING) continue;
    auditLinkTarget(auditor, asObject(target, `${markPath}.target`), markLocation);
  }
}

/** style 可缺（表格、图像没有单一字体），但一旦存在，两个字段都必须在。 */
function auditStyle(auditor: Auditor, element: JsonObject, elementLocation: FieldLocation): void {
  const style = auditor.optional(element, 'style');
  if (style === ABSENT) return;
  auditFields(
    auditor,
    asObject(style, `${elementLocation.path}.style`),
    location(elementLocation.elementId, `${elementLocation.path}.style`),
    ['fontFamily', 'fontSize'],
  );
}

function auditBboxes(auditor: Auditor, element: JsonObject, elementLocation: FieldLocation): void {
  const bboxes = auditor.optional(element, 'bboxes');
  if (bboxes === ABSENT) return;
  const values = asArray(bboxes, `${elementLocation.path}.bboxes`);
  for (let index = 0; index < values.length; index += 1) {
    const bboxPath = `${elementLocation.path}.bboxes[${index}]`;
    auditFields(
      auditor,
      asObject(values[index], bboxPath),
      location(elementLocation.elementId, bboxPath),
      ['page', 'bbox'],
    );
  }
}

function auditAnchors(auditor: Auditor, owner: JsonObject, ownerLocation: FieldLocation): void {
  const sourceObjectIds = auditor.optional(owner, 'sourceObjectIds');
  const sourceRasters = auditor.optional(owner, 'sourceRasters');
  if (sourceObjectIds === ABSENT && sourceRasters === ABSENT) {
    auditor.recordAnchorMissing(ownerLocation);
    return;
  }
  if (sourceObjectIds !== ABSENT) asArray(sourceObjectIds, `${ownerLocation.path}.sourceObjectIds`);
  if (sourceRasters !== ABSENT) {
    auditSourceRasters(
      auditor,
      asArray(sourceRasters, `${ownerLocation.path}.sourceRasters`),
      ownerLocation,
    );
  }
}

function auditSourceRasters(
  auditor: Auditor,
  rasters: unknown[],
  ownerLocation: FieldLocation,
): void {
  for (let index = 0; index < rasters.length; index += 1) {
    const rasterPath = `${ownerLocation.path}.sourceRasters[${index}]`;
    auditFields(
      auditor,
      asObject(rasters[index], rasterPath),
      location(ownerLocation.elementId, rasterPath),
      ['page', 'bbox', 'renderDpi', 'modelCallId'],
    );
  }
}

function auditProvenance(
  auditor: Auditor,
  element: JsonObject,
  elementLocation: FieldLocation,
): void {
  const value = auditor.required(element, 'provenance', elementLocation);
  if (value === MISSING) return;
  const provenancePath = `${elementLocation.path}.provenance`;
  const provenance = asObject(value, provenancePath);
  const provenanceLocation = location(elementLocation.elementId, provenancePath);

  const content = auditor.requiredObject(provenance, 'content', provenanceLocation);
  if (content) {
    auditFields(
      auditor,
      content,
      location(elementLocation.elementId, `${provenancePath}.content`),
      ['engine', 'role'],
    );
  }
  const layout = auditor.requiredObject(provenance, 'layout', provenanceLocation);
  if (layout) {
    auditor.required(
      layout,
      'engine',
      location(elementLocation.elementId, `${provenancePath}.layout`),
    );
    auditor.optional(layout, 'modelCallId');
  }
  const classification = auditor.requiredObject(provenance, 'classification', provenanceLocation);
  if (classification) {
    auditor.required(
      classification,
      'engine',
      location(elementLocation.elementId, `${provenancePath}.classification`),
    );
  }
  const assembly = auditor.requiredObject(provenance, 'assembly', provenanceLocation);
  if (assembly) {
    auditor.required(
      assembly,
      'version',
      location(elementLocation.elementId, `${provenancePath}.assembly`),
    );
  }
}

function auditList(auditor: Auditor, element: JsonObject, elementLocation: FieldLocation): void {
  const list = auditor.requiredObject(element, 'list', elementLocation);
  if (list) {
    auditFields(
      auditor,
      list,
      location(elementLocation.elementId, `${elementLocation.path}.list`),
      ['ordered', 'depth'],
    );
  }
}

function auditTable(auditor: Auditor, element: JsonObject, elementLocation: FieldLocation): void {
  const table = auditor.requiredObject(element, 'table', elementLocation);
  if (!table) return;
  const tablePath = `${elementLocation.path}.table`;
  const tableLocation = location(elementLocation.elementId, tablePath);
  auditFields(auditor, table, tableLocation, [
    'rows',
    'cols',
    'headerRows',
    'headerCols',
    'kind',
    'crossPage',
  ]);
  auditor.optional(table, 'pageSpan');
  auditor.optional(table, 'visualGroupId');
  auditor.optional(table, 'caption');
  const cells = auditor.requiredArray(table, 'cells', tableLocation);
  if (!cells) return;
  for (let index = 0; index < cells.length; index += 1) {
    const cellPath = `${tablePath}.cells[${index}]`;
    const cell = asObject(cells[index], cellPath);
    const cellLocation = location(elementLocation.elementId, cellPath);
    auditFields(auditor, cell, cellLocation, [
      'r',
      'c',
      'rowSpan',
      'colSpan',
      'text',
      'bbox',
      'isHeader',
      'role',
    ]);
    auditor.optional(cell, 'page');
    auditor.optional(cell, 'confidence');
    auditOptionalAnchors(auditor, cell, cellLocation);
  }
}

function auditOptionalAnchors(
  auditor: Auditor,
  owner: JsonObject,
  ownerLocation: FieldLocation,
): void {
  const sourceObjectIds = auditor.optional(owner, 'sourceObjectIds');
  if (sourceObjectIds !== ABSENT) {
    asArray(sourceObjectIds, `${ownerLocation.path}.sourceObjectIds`);
  }
  const sourceRasters = auditor.optional(owner, 'sourceRasters');
  if (sourceRasters !== ABSENT) {
    auditSourceRasters(
      auditor,
      asArray(sourceRasters, `${ownerLocation.path}.sourceRasters`),
      ownerLocation,
    );
  }
}

function auditFigure(auditor: Auditor, element: JsonObject, elementLocation: FieldLocation): void {
  const figure = auditor.requiredObject(element, 'figure', elementLocation);
  if (figure) {
    auditFields(
      auditor,
      figure,
      location(elementLocation.elementId, `${elementLocation.path}.figure`),
      ['assetPath', 'kind'],
    );
  }
}

function auditFormula(auditor: Auditor, element: JsonObject, elementLocation: FieldLocation): void {
  const formula = auditor.requiredObject(element, 'formula', elementLocation);
  if (!formula) return;
  auditor.optional(formula, 'latex');
  auditor.required(
    formula,
    'display',
    location(elementLocation.elementId, `${elementLocation.path}.formula`),
  );
}

function auditCode(auditor: Auditor, element: JsonObject, elementLocation: FieldLocation): void {
  const code = auditor.requiredObject(element, 'code', elementLocation);
  if (code) {
    auditor.required(
      code,
      'language',
      location(elementLocation.elementId, `${elementLocation.path}.code`),
    );
  }
}

function auditFields(
  auditor: Auditor,
  record: JsonObject,
  locationValue: FieldLocation,
  fields: readonly string[],
): void {
  for (const field of fields) auditor.required(record, field, locationValue);
}

function asObject(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} 必须是对象`);
  }
  return value as JsonObject;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} 必须是数组`);
  return value;
}

function location(elementId: string, path: string): FieldLocation {
  return { elementId, path };
}

function stringHint(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}
