/** G12 在真实财报上标定的最小线长；更短的轴向笔画不具备单元格边界意义。 */
export const TABLE_RULE_MIN_LENGTH_PT = 4;

/** 细长填充矩形的短边上限；中文财报常用 re + f 画边线。 */
export const TABLE_RULE_MAX_THICKNESS_PT = 2;

/** 填充矩形至少达到该长宽比才算线，避免把单元格底色误吸收为网格。 */
export const TABLE_RULE_MIN_ASPECT_RATIO = 8;

/** G12 的 0.05–1pt 稳定平台内取 0.25pt，用于同轴线段聚类与端点续接。 */
export const TABLE_RULE_MERGE_TOLERANCE_PT = 0.25;

/** 可见笔画相交允许半个线宽外再有的端点误差；覆盖 G12 实测的 0.24pt 缝隙。 */
export const TABLE_RULE_INTERSECTION_TOLERANCE_PT = 0.25;

/** 至少 2×2 个逻辑单元格才称为表；单个公告框不能冒充表格。 */
export const TABLE_GRID_MIN_ROWS = 2;
export const TABLE_GRID_MIN_COLS = 2;

/** 阶段⑥只落确定性 ruled table；闭合不足的候选留给后续升级路径。 */
export const TABLE_GRID_MIN_CLOSURE = 0.9;

/** 闭合网格的行带与列带都至少有一半真的装着文字，才算表格而不是空框或装饰边。 */
export const TABLE_GRID_MIN_CELL_TEXT_HIT_RATE = 0.5;

/** 判断某条分隔线是否覆盖原子单元格中心时允许的几何误差。 */
export const TABLE_CELL_BORDER_TOLERANCE_PT = 0.3;

/** 同一 cell 内文字按 baseline 聚行的绝对容差。 */
export const TABLE_CELL_LINE_TOLERANCE_PT = 2;

/** 一行中非数字 cell 达到该份额，且下一行以数字为主时，判为表头行。 */
export const TABLE_HEADER_TEXT_SHARE = 0.6;

/** 本地闭合网格的分类置信度；仍为推断值，不能取满分。 */
export const TABLE_LAYOUT_CONFIDENCE = 0.9;

/**
 * 无框线表以显式表编号为入口；编号是版式事实，不依赖文件、页码或 metadata。
 * 中文期刊把编号与题注写在同一行（`表 1 各学年训练形式`），英文期刊把 `TABLE I`
 * 单独成行，因此编号后允许跟题注，不再要求整个文本对象就是编号本身。
 * 误匹配只会走到列锚/行序不闭合的拒绝分支并留下 warn，不会凭空造出表格。
 */
export const BORDERLESS_TABLE_LABEL =
  /^(?:TABLE\s+[IVXLCDM\d]+|表\s*(?:\d+|[一二三四五六七八九十百]+))(?:\s|$)/iu;

/** 同一无框线表行的顶边抖动上限，量纲为该行字号。 */
export const TABLE_BORDERLESS_LINE_TOLERANCE_RATIO = 0.25;

/**
 * 判定表编号时向右拼接同基线相邻 run 的最大间隙，量纲为该 run 字号。
 * 题注常在编号与标题之间留出比字距更宽的间隔，取值需覆盖该间隔；栏间距远大于此，
 * 拼接不会跨栏。
 */
export const TABLE_BORDERLESS_LABEL_RUN_GAP_RATIO = 1.5;

/** 表内相邻排版行的步长上限；超过 2.3em 即结束候选，避免吞入后续正文。 */
export const TABLE_BORDERLESS_MAX_LINE_STEP_RATIO = 2.3;

/** 同一列左边界的排版抖动允许 1.1em，用于聚合居中的短值与左对齐表头。 */
export const TABLE_BORDERLESS_COLUMN_ANCHOR_TOLERANCE_RATIO = 1.1;

/** 缺失的首列表头只有在数据左边界至少领先 2em 时才补入，避免把单元格内缩进当列。 */
export const TABLE_BORDERLESS_MISSING_HEADER_GAP_RATIO = 2;

/** 数据左边界至少在两行复现，才有资格补成一个空表头列。 */
export const TABLE_BORDERLESS_MIN_ANCHOR_REPETITIONS = 2;

/** 文字起点可向列锚左侧漂移半个字号，仍归入该列。 */
export const TABLE_BORDERLESS_COLUMN_SNAP_RATIO = 0.5;

/** 相邻列锚至少相隔 2em；更近的是同一单元格内的文字碎片。 */
export const TABLE_BORDERLESS_MIN_COLUMN_GAP_RATIO = 2;

/** 编号、列锚复现、行序单调三份证据闭合后的本地无框线表置信度。 */
export const TABLE_BORDERLESS_CONFIDENCE = 0.88;

/** ruled 表向上最多检查 2.5em 的标题邻接，距离更远的文字仍是独立正文。 */
export const TABLE_LABEL_MAX_GAP_RATIO = 2.5;

/** 标题多行之间的空隙不得超过 1.2em。 */
export const TABLE_LABEL_LINE_GAP_RATIO = 1.2;

/** V0 最多关联“标题 + 单位/副标题”两行，防止连续正文被整段吸入表格。 */
export const TABLE_LABEL_MAX_LINES = 2;

/** 可作为 ruled 表标题的通用显式编号；不包含任何用例文本。 */
export const TABLE_NEARBY_LABEL = /^(?:TABLE\s+[IVXLCDM\d]+|表\s*[一二三四五六七八九十\d]+|[一二三四五六七八九十]+[、.])/iu;

/** 表格断行中，单独出现的首字母大写短前缀更可能是语义连字符（如 Sub-）。 */
export const TABLE_STANDALONE_HYPHENATED_PREFIX = /^\p{Lu}[\p{L}]{1,4}-$/u;
