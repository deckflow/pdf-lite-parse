/** 同一行的 baseline 容差，量纲是相邻文字字号；RFC § 4.2 固定为 0.35。 */
export const LINE_TOL_RATIO = 0.35;

/** 同基线文字之间超过 3em 的空洞视为两个独立版面行，避免图内标签粘进正文。 */
export const LINE_SEGMENT_GAP_RATIO = 3;

/** 独立项目符号只承载 marker；正文必须从符号后的文字源对象开始，才能按 C9 寻址。 */
export const STANDALONE_LIST_MARKER = /^(?:[-*•▪◦]|\d+[.)、．])$/u;

/**
 * 符号字体（Wingdings / ZapfDingbats / Symbol …）把项目符号编在私用区，
 * ToUnicode 只能给出 U+F0xx 这类没有通用语义的码位。字体名是判断"这个私用区码位
 * 究竟是什么"的唯一依据，所以 marker 识别必须字体名与码位一起看。
 */
export const SYMBOL_BULLET_FONT_NAME =
  /(?:wingdings|webdings|zapf\s*dingbats|dingbat|symbol|marlett|monotypesorts)/iu;

/** Unicode 基本多文种平面的私用区；符号字体的字形码位都落在这一段。 */
export const PRIVATE_USE_AREA_FIRST = 0xe000;
export const PRIVATE_USE_AREA_LAST = 0xf8ff;

/**
 * 符号字体里习惯用作项目符号的字符码（私用区码位的低 8 位）。
 * 只列公认的实心/空心圆点方块与勾叉箭头 —— 私用区没有标准，多列一个
 * 就是多一个把正文字符误判成 marker 的机会。
 */
export const SYMBOL_BULLET_CHARACTER_CODES: ReadonlySet<number> = new Set([
  0x6c, // Wingdings 'l' → 实心圆
  0x6e, // Wingdings 'n' → 实心方
  0x6f, // Wingdings 'o' → 空心方
  0x75, // Wingdings 'u' → 实心菱
  0x76, // Wingdings 'v' → 空心菱
  0xa7, // Wingdings '§' → 小实心方（PowerPoint 默认项目符号）
  0xa8, // Wingdings '¨' → 小空心方
  0xb7, // Symbol '·' → 圆点
  0xd8, // Wingdings 'Ø' → 箭头
  0xfc, // Wingdings 'ü' → 勾
]);

/**
 * marker 与正文之间允许的最大水平间隙，量纲是 marker 字号。PowerPoint 的悬挂缩进
 * 常留一整个字身宽的空档，比 LINE_SEGMENT_GAP_RATIO 的通用切分更宽松。
 */
export const LIST_MARKER_MAX_GAP_RATIO = 4;

/** 拉丁/数字相邻 chunk 的间隙超过平均字宽的这一比例时，推断一个空格。 */
export const SPACE_GAP_RATIO = 0.5;

/** bbox 无法给出有效平均字宽时，以字号的这一比例作为单字宽降级估计。 */
export const FALLBACK_AVERAGE_GLYPH_WIDTH_RATIO = 0.5;

/** 普通相邻行的视觉空隙不得超过字号的这一比例；更大的空隙默认表示新块。 */
export const BLOCK_LINE_GAP_RATIO = 0.6;

/** 已有换行证据时覆盖常见中文公文约 1em 的行间空白。 */
export const BLOCK_WRAPPED_LINE_GAP_RATIO = 1.05;

/** 上一行比末行至少长出这一字号比例，才把短末行当作自动换行而非新段。 */
export const BLOCK_SHORT_FINAL_LINE_MIN_RATIO = 2;

/** 字形 bbox 允许轻微相叠，但超过这一字号比例就不能视为正常连续行。 */
export const BLOCK_LINE_OVERLAP_RATIO = 0.2;

/** 普通连续行左边界允许的排版抖动，量纲是块主字号。 */
export const BLOCK_LEFT_ALIGNMENT_RATIO = 0.5;

/** 居中标题的相邻行按中心线而非左边界对齐；只对块首两行开放。 */
export const BLOCK_CENTER_ALIGNMENT_RATIO = 0.5;

/** 连续行字号的相对差异上限；标题与正文不能只因紧邻就合成一个块。 */
export const BLOCK_FONT_SIZE_TOLERANCE_RATIO = 0.08;

/** 首行缩进或列表悬挂缩进允许的最大位移；中文两字缩进需要覆盖到 2em。 */
export const HANGING_INDENT_MAX_RATIO = 2.5;

/** 常见 PDF 子集字体名中的等宽字体标记；只作为代码分类证据，不改写文字。 */
export const MONOSPACE_FONT_NAME = /(?:mono|courier|typewriter|t1x(?:b)?tt)/iu;

/** 等宽字体覆盖绝大多数字符才把一行判为代码，避免正文里的单个命令误伤整段。 */
export const CODE_MONOSPACE_CHARACTER_SHARE = 0.8;

/** 章节标记是确定性语义证据；一级与二级规则同时用于分块和 heading.level。 */
export const PRIMARY_HEADING_MARKER = /^(?:[IVXLCDM]+\.\s+|[一二三四五六七八九十百]+[、.．]\s*)/u;
export const SECONDARY_HEADING_MARKER = /^(?:[A-Z]\.\s+|[（(](?:[一二三四五六七八九十百]+|\d+)[）)]\s*)/u;

/**
 * 阿拉伯数字分级编号（`1`、`2.1`、`2.1.1`）是 GB/T 7713 与多数期刊的章节写法，
 * 层级深度直接由小节个数给出。编号后必须是空白，且正文首字符不是数字：
 * `1.` / `1)` / `1、` 属于列表 marker，`2 15%` 属于表格数字行，两者都不是章节。
 * 每节限两位数：章节序号不会到三位，`2025 年第 16 期` 这类年份/刊期才会。
 */
export const NUMERIC_HEADING_MARKER = /^\d{1,2}(?:\.\d{1,2})*\s+(?=[^\d\s])/u;

/**
 * 章节标题是短行；超过该可见字符数的块按正文处理。主判据是"整块只有一行"——
 * 正文段落是多行块——本项只作兜底，取值需容得下较长的英文标题。
 */
export const NUMERIC_HEADING_MAX_CHARACTERS = 48;

/** 新列表项必须开启新块；其后没有 marker 的视觉续行仍可并回本项。 */
export const LIST_ITEM_START_MARKER = /^(?:\d+[、.)]|[-*•▪◦]\s*)/u;

/** 图号是图对象的确定性文字锚；大小写差异不改变分类。 */
export const FIGURE_CAPTION_MARKER = /^(?:fig(?:ure)?\.?\s*\d+\s*[:.]?)/iu;

/** 图内“左节点—小连接词—右节点”的三段基线容差，量纲是外侧标签字号。 */
export const DIAGRAM_RELATION_BASELINE_TOLERANCE_RATIO = 1.1;

/** 连接词字号必须明显小于两侧节点，防止普通三栏正文被误认成图关系。 */
export const DIAGRAM_RELATION_CONNECTOR_FONT_MAX_RATIO = 0.8;

/** 两侧节点字号允许的相对差异；它们应属于同一视觉层级。 */
export const DIAGRAM_RELATION_OUTER_FONT_TOLERANCE_RATIO = 0.12;

/** 连接词到任一节点的水平距离上限，量纲是节点字号。 */
export const DIAGRAM_RELATION_MAX_HORIZONTAL_GAP_RATIO = 12;

/** 连接词只允许短标签；长中栏更可能是表格或三栏正文。 */
export const DIAGRAM_RELATION_CONNECTOR_MAX_CHARACTERS = 16;

/** 元素层 heading.level 的固定语义，不是按页重新估计的字号排名。 */
export const PRIMARY_HEADING_LEVEL = 1;
export const SECONDARY_HEADING_LEVEL = 2;

/**
 * 本地版面尚未识别嵌套列表，全部按平铺的第 0 层落盘。
 * 与其用缩进量猜一个层级，不如显式地只承诺"这是列表项"这一件已知的事。
 */
export const LIST_ITEM_FLAT_DEPTH = 0;

/** 本地几何版面对可解引用源对象给出的置信度；未包含语义分类置信度。 */
export const LOCAL_LAYOUT_CONFIDENCE = 0.9;

/**
 * 文字行落进图像 bbox 的面积占比达到这一比例即判为"画在图上的标签"。
 * 不用"完全包含"是因为字形 bbox 常比排版框略大半个像素，严格包含会漏掉贴边的标签。
 */
export const FIGURE_OWNED_TEXT_CONTAINMENT_RATIO = 0.9;

/** 图注必须与图在水平方向重叠这一比例，才可能属于同一张图。 */
export const FIGURE_CAPTION_HORIZONTAL_OVERLAP_RATIO = 0.5;

/** 图注与图边缘的最大垂直间隙，量纲是图注字号；负间隙（压在图上）一律允许。 */
export const FIGURE_CAPTION_MAX_GAP_RATIO = 2.5;

/**
 * 字号按这个步长归桶再统计。同一视觉层级在不同页常有 0.02pt 级的浮点抖动，
 * 不归桶就会把一层标题拆成好几个"不同字号"。
 */
export const FONT_SIZE_BUCKET_PT = 0.5;

/**
 * 标题字号相对正文字号的最小倍率。实测幻灯片的二级标题只比正文大 11%
 * （20.04pt vs 18pt），常见的 1.15 会直接漏掉它。
 */
export const HEADING_FONT_SIZE_MIN_RATIO = 1.08;

/** 标题是短块：超过这些行数或可见字符数的块一律按正文处理。 */
export const HEADING_MAX_LINES = 2;
export const HEADING_MAX_CHARACTERS = 80;

/**
 * 正文字号必须覆盖全文这一比例的字符，才敢拿它当"正文基准"去判标题。
 * 达不到就说明这份文档没有稳定正文，此时只保留编号标题判据。
 */
export const BODY_FONT_SIZE_MIN_SHARE = 0.2;

/** 同一字号在全文出现的字符数超过这一比例，就不再像标题而像另一种正文。 */
export const HEADING_FONT_SIZE_MAX_SHARE = 0.35;

/** 字号桶要有这么多字符才配拥有一个层级；否则一个孤立的大字形就能凭空造出一层。 */
export const HEADING_FONT_SIZE_MIN_CHARACTERS = 8;

/**
 * 字号排名最多给出这么多层。再往下，层与层的字号差已经小于排版噪声，
 * 实测第 4 层拿到的是作者单位那种"恰好稍大一点"的行，不是标题。
 */
export const HEADING_FONT_SIZE_MAX_LEVELS = 3;

/** 标题不以句末标点或右括号收尾；作者单位、图注、正文尾行都栽在这一条上。 */
export const HEADING_FORBIDDEN_TAIL = /[.。．!！?？;；:：,，、)）\]】》」』]$/u;

/**
 * 独立成行的展示公式相对页面中心的最大偏移，量纲是页宽。
 * 排版惯例是把展示公式居中，这条是把它与左对齐正文区分开的主要几何证据。
 */
export const FORMULA_CENTER_TOLERANCE_RATIO = 0.06;

/**
 * 公式里不应出现普通词：连续这么多个拉丁字母就说明这是句子而不是式子。
 * `PL(k) = B + As∆θ(k) + v(k)` 的最长字母串是 2，`where … for summer loads` 是 6。
 */
export const FORMULA_MAX_LATIN_RUN = 3;

/** 压在假想栏界上的区块要占到这么宽才算通栏分隔带，否则按中点归栏。 */
export const SPANNING_REGION_MIN_WIDTH_SHARE = 0.5;

/** 判断跨栏区块是否"同一行"的绝对容差；字号不同的并列项顶边会差一两个点。 */
export const GRID_ROW_TOP_TOLERANCE_PT = 2;

/** 少于这么多条跨栏等高行就还只是巧合，不足以推翻按栏阅读。 */
export const GRID_MIN_ALIGNED_ROWS = 3;

/** 带内区块参与跨栏等高行的占比达到该值，才把这条带判成按行阅读的网格。 */
export const GRID_MIN_ALIGNED_REGION_SHARE = 0.6;
