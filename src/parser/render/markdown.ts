import type {
  DocumentModelArtifact,
  MissingField,
  ResultArtifact,
} from '../../schema/artifacts.ts';
import { ARTIFACT_SCHEMA_VERSIONS } from '../../schema/artifacts.ts';
import type {
  Annotation,
  Element,
  LinkTarget,
  Mark,
  OutlineNode,
  TableInfo,
} from '../../schema/element.ts';
import { auditDocument } from './audit.ts';

type RenderDocument = DocumentModelArtifact | ResultArtifact;

export interface MarkdownRenderResult {
  markdown: string;
  missingFields: MissingField[];
}

export interface MarkdownRenderOptions {
  /**
   * 写出溯源注释：每个元素前一行 `<!-- element {...} -->`，内含该元素的完整 JSON
   * （含 sourceObjectIds 与 provenance）。**默认关闭。**
   *
   * 关掉是因为它压倒性地主导了输出体积——实测一篇 IEEE 论文 349KB 的 Markdown 里
   * 292KB（84%）是注释，正文只有 57KB。而 Markdown 的用途是「给人读、给下游模型读」，
   * 那里注释纯属噪音；溯源本来就该看 result.json，那份 IR 一个字段都没少。
   * 需要在 Markdown 上就地对照溯源时才打开——那是调试场景。
   */
  metadata?: boolean;
}

export function renderMarkdown(
  input: unknown,
  options: MarkdownRenderOptions = {},
): MarkdownRenderResult {
  const withMetadata = options.metadata ?? false;
  const missingFields = auditDocument(input);
  if (missingFields.length > 0) {
    return {
      markdown: renderMissingFields(missingFields),
      missingFields,
    };
  }

  const document = input as RenderDocument;
  const elements = [...document.elements];
  if (Object.prototype.hasOwnProperty.call(document, 'furniture')) {
    const furniture = document.furniture;
    if (furniture) elements.push(...furniture);
  }
  elements.sort((left, right) => left.order - right.order);

  const blocks = [
    renderDocumentMetadata(document, withMetadata),
    ...renderOutline(document.outline),
    ...elements.filter(element => !(element.type === 'list' && element.text.length === 0
      && elements.some(child => child.parentId === element.id && child.type === 'list_item')))
      .map((element) => renderElement(element, withMetadata)),
    ...document.annotations.map((annotation) => renderAnnotation(annotation, withMetadata)),
    // 关掉注释后，纯元数据的块（文档头、页面家具）会渲染成空串——它们在 Markdown 里
    // 本来就没有正文对应物。必须在这里滤掉，否则 join 出一串空行。
  ].filter((block) => block.length > 0);
  return {
    markdown: `${blocks.join('\n\n')}\n`,
    missingFields,
  };
}

function renderMissingFields(missingFields: MissingField[]): string {
  const lines = ['# Markdown render degraded: missing fields'];
  for (const missing of missingFields) {
    lines.push(`- ${missing.path}: ${missing.message}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderDocumentMetadata(document: RenderDocument, withMetadata: boolean): string {
  if (!withMetadata) return '';
  const metadata: Record<string, unknown> = {
    schemaVersion: document.schemaVersion,
    source: document.source,
    docInfo: document.docInfo,
    pages: document.pages,
  };
  if (document.schemaVersion === ARTIFACT_SCHEMA_VERSIONS.result) {
    metadata.version = document.version;
    metadata.profile = document.profile;
    metadata.warnings = document.warnings;
    metadata.stats = document.stats;
  }
  return htmlComment('document', metadata);
}

/**
 * 大纲渲染成嵌套列表。它是文档自己声明的导航结构，与 heading 推断出的树不是一回事，
 * 所以单独成块而不是混进正文流。
 */
/**
 * 大纲块的 `<!-- outline -->` 标记**两种模式都保留**，它不是溯源元数据：
 * 每份文档就一处、十几个字节，而没有它，开头那串书签列表和正文的项目符号列表长得一样，
 * 人和下游模型都分不出来。真正撑体积的是每元素一份的 JSON，那个才是 metadata 开关管的。
 */
function renderOutline(outline: OutlineNode[] | null): string[] {
  if (outline === null || outline.length === 0) return [];
  const lines: string[] = ['<!-- outline -->'];
  const walk = (nodes: readonly OutlineNode[], depth: number): void => {
    for (const node of nodes) {
      const indent = '  '.repeat(depth);
      lines.push(`${indent}- ${node.title}${node.target === null ? '' : ` → ${targetText(node.target)}`}`);
      walk(node.children, depth + 1);
    }
  };
  walk(outline, 0);
  return [lines.join('\n')];
}

/** 批注不在正文流里（它没有阅读顺序），但必须出现在渲染结果中，否则等于渲染丢内容。 */
function renderAnnotation(annotation: Annotation, withMetadata: boolean): string {
  const target = annotation.target === null ? '' : ` → ${targetText(annotation.target)}`;
  const body = `> [${annotation.subtype} p${annotation.page}]${target} ${annotation.contents}`;
  return withMetadata ? `${htmlComment('annotation', annotation)}\n${body}` : body;
}

function targetText(target: LinkTarget): string {
  if (target.kind === 'external') return target.href;
  const page = target.page === null ? '?' : String(target.page);
  return target.destination === null ? `#p${page}` : `#p${page}:${target.destination}`;
}

function renderElement(element: Element, withMetadata: boolean): string {
  const text = renderMarkedText(element.text, element.marks);
  let body: string;

  switch (element.type) {
    case 'unknown':
      // 未分类元素没有 Markdown 对应物：原文照出，类型未定这件事由上面的元数据注释说明。
      body = text;
      break;
    case 'heading':
      body = `${'#'.repeat(element.level)} ${text}`;
      break;
    case 'paragraph':
      body = text;
      break;
    case 'footnote':
      body = `[^${element.id}]: ${text}`;
      break;
    case 'list': {
      const indent = '  '.repeat(element.list.depth);
      const marker = element.list.ordered ? '1.' : '-';
      body = `${indent}${marker} ${text}`;
      break;
    }
    case 'list_item':
      body = `${'  '.repeat(element.depth)}${markdownListMarker(element.marker)} ${text}`;
      break;
    case 'table':
      body = renderTable(element.table);
      break;
    case 'figure':
    case 'chart':
      body = renderFigure(element.type, text, element.figure.assetPath, element.figure.kind);
      break;
    case 'caption':
      // captionOf 注释挂在正文行尾，不是独占一行——想事后按行剥离注释的人要当心，
      // 整行丢掉会把图注本身一起带走。
      body = withMetadata
        ? `_${text}_ <!-- captionOf=${json(element.captionOf)} -->`
        : `_${text}_`;
      break;
    case 'formula': {
      let formulaText = element.text;
      if (Object.prototype.hasOwnProperty.call(element.formula, 'latex')) {
        const latex = element.formula.latex;
        if (latex !== undefined) formulaText = latex;
      }
      body = element.formula.display ? `$$${formulaText}$$` : `$${formulaText}$`;
      break;
    }
    case 'code': {
      let openingFence = '```';
      if (element.code.language !== null) openingFence += element.code.language;
      body = `${openingFence}\n${element.text}\n\`\`\``;
      break;
    }
    case 'header':
    case 'footer':
    case 'gutter':
    case 'watermark':
    case 'page_number':
    case 'stamp':
      // 页面家具（页眉页脚水印等）在 Markdown 里没有正文对应物，只以注释形式存在。
      // 关掉注释时它整块消失——这是对的：它本来就不属于阅读流，IR 里一条不少。
      body = withMetadata
        ? htmlComment(
          'furniture',
          { type: element.type, furnitureKind: element.furnitureKind, text: element.text },
        )
        : '';
      break;
  }

  if (!withMetadata) return body;
  return `${htmlComment('element', element)}\n${body}`;
}

/**
 * IR 里的 marker 是原文（Wingdings 的项目符号就是一个私用区码位），渲染成 Markdown
 * 时必须换成 Markdown 表达得了的形态 —— 归一化是渲染器的职责，不是解析器的。
 * 有序编号原样保留，它在 Markdown 里本来就有对应写法。
 */
function markdownListMarker(marker: string): string {
  return ORDERED_LIST_MARKER.test(marker) ? marker : '-';
}

const ORDERED_LIST_MARKER = /^(?:\d+|[A-Za-z]|[ivxlcdm]+)[.)]$/u;

function renderTable(table: TableInfo): string {
  const { rows, cols, cells } = table;
  const grid = Array.from({ length: rows }, () => Array<string>(cols).fill(''));
  for (const cell of cells) {
    if (cell.r >= 0 && cell.r < rows && cell.c >= 0 && cell.c < cols) {
      grid[cell.r][cell.c] = escapeTableCell(cell.text);
    }
  }

  const lines: string[] = [];
  // 题注在 IR 里是 table 的一部分，Markdown 的管道表却没有题注语法。写成表格上方的
  // 独立一行是它唯一不丢的去处——留在 element.text 里等于只有读注释的人看得见，
  // 而注释是元数据，不是渲染本体。它是正文而非单元格，因此不套用 cell 转义。
  if (table.caption !== undefined && table.caption.length > 0) {
    lines.push(table.caption, '');
  }
  for (let row = 0; row < grid.length; row += 1) {
    lines.push(`| ${grid[row].join(' | ')} |`);
    if (row === 0) lines.push(`| ${Array<string>(cols).fill('---').join(' | ')} |`);
  }
  return lines.join('\n');
}

function renderFigure(
  type: 'figure' | 'chart',
  text: string,
  assetPath: string | null,
  kind: 'raster' | 'vector',
): string {
  if (assetPath !== null) return `![${text}](${assetPath})`;
  return `[${type}:${kind}] ${text}`;
}

function renderMarkedText(text: string, marks: Mark[] | undefined): string {
  if (marks === undefined || marks.length === 0) return text;
  const openings = new Map<number, Mark[]>();
  const closings = new Map<number, Mark[]>();

  for (const mark of marks) {
    appendMark(openings, mark.start, mark);
    appendMark(closings, mark.end, mark);
  }

  let rendered = '';
  for (let offset = 0; offset <= text.length; offset += 1) {
    const closing = closings.get(offset);
    if (closing) {
      closing.sort((left, right) => right.start - left.start);
      for (const mark of closing) rendered += closeMark(mark);
    }
    const opening = openings.get(offset);
    if (opening) {
      opening.sort((left, right) => right.end - left.end);
      for (const mark of opening) rendered += openMark(mark);
    }
    if (offset < text.length) rendered += text.slice(offset, offset + 1);
  }
  return rendered;
}

function appendMark(target: Map<number, Mark[]>, offset: number, mark: Mark): void {
  const existing = target.get(offset);
  if (existing) existing.push(mark);
  else target.set(offset, [mark]);
}

function openMark(mark: Mark): string {
  switch (mark.type) {
    case 'bold': return '**';
    case 'italic': return '*';
    case 'underline': return '<u>';
    case 'strike': return '~~';
    case 'sup': return '<sup>';
    case 'sub': return '<sub>';
    case 'code': return '`';
    case 'link': return '[';
  }
}

function closeMark(mark: Mark): string {
  switch (mark.type) {
    case 'bold': return '**';
    case 'italic': return '*';
    case 'underline': return '</u>';
    case 'strike': return '~~';
    case 'sup': return '</sup>';
    case 'sub': return '</sub>';
    case 'code': return '`';
    case 'link': return `](${targetText(mark.target)})`;
  }
}

function escapeTableCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function htmlComment(label: string, value: unknown): string {
  return `<!-- ${label} ${json(value)} -->`;
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('渲染元数据无法序列化');
  return encoded;
}
