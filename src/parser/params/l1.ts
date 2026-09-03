/** Type0/Identity-H 无 ToUnicode 的字体必须覆盖超过该字符份额，才构成结构硬证据。 */
export const TEXT_LAYER_UNMAPPABLE_FONT_SHARE = 0.3;

/** 以下比例都是“可见字符中的份额”，避免 PDF chunk 切分方式改变判定。 */
export const TEXT_LAYER_REPLACEMENT_RATE = 0.01;
export const TEXT_LAYER_CID_ESCAPE_RATE = 0.02;
export const TEXT_LAYER_SUSPICIOUS_CODEPOINT_RATE = 0.01;
export const TEXT_LAYER_MIN_SUSPICIOUS_CHARACTERS = 2;

/** 语言画像至少需要这些字符/词，短标题不会凭几个符号被判成乱码。 */
export const TEXT_LAYER_LANGUAGE_MIN_CHARACTERS = 40;
export const TEXT_LAYER_LANGUAGE_MIN_WORDS = 8;
export const TEXT_LAYER_LANGUAGE_WORD_MIN_CHARACTERS = 4;
export const TEXT_LAYER_ZH_PROFILE_CJK_SHARE = 0.15;
export const TEXT_LAYER_ZH_PROFILE_LATIN_SHARE = 0.5;
export const TEXT_LAYER_DOCUMENT_CJK_SHARE = 0.1;
export const TEXT_LAYER_EN_GIBBERISH_WORD_SHARE = 0.22;
export const TEXT_LAYER_CONSONANT_RUN = 5;

/** bbox 与面积信号。重叠计算忽略仅仅擦边的对象。 */
export const PROBE_AREA_DECIMAL_PLACES = 6;
export const IMAGE_TEXT_OVERLAP_SHARE = 0.2;
export const MIXED_TEXT_IMAGE_MIN_IMAGE_SHARE = 0.08;
export const SCANNED_PAGE_IMAGE_SHARE = 0.8;
export const SCANNED_PAGE_MAX_TEXT_DENSITY = 0.08;
/** 大半页是位图而文字只占极小面积时，少量标题/页码不足以证明正文有文本层。 */
export const PARTIAL_SCAN_MIN_IMAGE_SHARE = 0.5;
export const PARTIAL_SCAN_MAX_TEXT_DENSITY = 0.02;

/** 矢量密度按每平方英寸的对象数表达，避免 A4/Letter 页尺寸影响量纲。 */
export const POINTS_PER_INCH = 72;
export const CHART_MIN_VECTOR_OBJECTS = 10;
export const CHART_MAX_MEAN_TEXT_LENGTH = 18;
export const CHART_MIN_NUMERIC_TOKENS = 4;

/** 与整页 /Rotate 分开：这里只看文字基线相对水平方向的偏离。 */
export const ROTATED_TEXT_MIN_DEGREES = 5;

/** 从 graphic bbox 还原轴向 rule；细长填充同样能承载表格边线。 */
export const RULE_MIN_LENGTH_PT = 4;
export const RULE_MAX_THICKNESS_PT = 2;
export const RULE_MIN_ASPECT_RATIO = 8;
export const RULE_INTERSECTION_TOLERANCE_PT = 0.75;
export const RULE_CLUSTER_TOLERANCE_PT = 0.75;
export const RULED_TABLE_MIN_AXIS_RULES = 2;
export const RULED_TABLE_MIN_GRID_CLOSURE = 0.55;
export const RULED_TABLE_MIN_CELL_TEXT_HIT_RATE = 0.2;

/** borderless 表先聚 baseline，再检查三列以上的重复对齐；两列正文不入候选。 */
export const TABLE_ROW_BASELINE_TOLERANCE_PT = 2;
export const TABLE_CELL_GAP_PT = 8;
export const BORDERLESS_TABLE_MIN_ROWS = 3;
export const BORDERLESS_TABLE_MIN_COLUMNS = 3;
export const BORDERLESS_TABLE_MIN_ROW_CONSISTENCY = 0.6;
export const BORDERLESS_TABLE_ALIGNMENT_TOLERANCE_PT = 4;
export const BORDERLESS_TABLE_MIN_COLUMN_SUPPORT = 0.6;
export const BORDERLESS_TABLE_MAX_ALIGNMENT_ENTROPY = 0.45;

/** 分栏用 x 投影空白；只在页面中央寻找 gutter，页边距不能冒充分栏。 */
export const COLUMN_PROJECTION_BINS = 120;
export const COLUMN_GUTTER_SEARCH_MIN_SHARE = 0.3;
export const COLUMN_GUTTER_SEARCH_MAX_SHARE = 0.7;
export const COLUMN_GUTTER_MAX_OCCUPANCY_SHARE = 0.12;
export const COLUMN_GUTTER_MIN_WIDTH_PT = 8;
export const COLUMN_GUTTER_MAX_WIDTH_SHARE = 0.16;
export const COLUMN_MIN_SIDE_CHARACTER_SHARE = 0.2;
export const COLUMN_MIN_GUTTER_PURITY = 0.92;
export const COLUMN_THRESHOLD_PERTURBATION = 0.2;
export const COLUMN_MAX_COLUMNS = 4;
/** 跨栏摘要会淹没整页投影；局部栏证据必须在两侧各有多行宽正文。 */
export const COLUMN_BAND_MIN_LINES = 8;
export const COLUMN_BAND_MIN_TEXT_WIDTH_SHARE = 0.2;

/** 风险只汇总探测残差；“有表/有图”本身不构成风险。 */
export const PROBE_MEDIUM_UNCERTAINTY = 0.25;
export const PROBE_HIGH_UNCERTAINTY = 0.7;
export const PROBE_PARTIAL_TEXT_UNCERTAINTY = 0.5;
export const PROBE_OVERLAID_TEXT_UNCERTAINTY = 0.3;

/** ruled / borderless 置信度里的几何与文字证据等权，名字化以免算法里散落权重。 */
export const TABLE_GEOMETRY_CONFIDENCE_WEIGHT = 0.5;
export const TABLE_TEXT_CONFIDENCE_WEIGHT = 0.5;

/** 公式信号要求至少出现一个明确数学码位或数学字体，而不是见数字就算公式。 */
export const FORMULA_MIN_MATH_CHARACTERS = 1;
