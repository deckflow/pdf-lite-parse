/** 家具只在页顶/页底带聚类，避免固定栏位正文与表头被误杀。 */
export const FURNITURE_EDGE_BAND_SHARE = 0.14;
export const FURNITURE_POSITION_BIN_SHARE = 0.015;
export const FURNITURE_MIN_REPEAT_PAGES = 2;
export const FURNITURE_MIN_DOCUMENT_SHARE = 0.3;
export const FURNITURE_MIN_TEXT_CHARACTERS = 1;
export const FURNITURE_MAX_TEXT_CHARACTERS = 180;
export const FURNITURE_POSITION_WEIGHT = 0.45;
export const FURNITURE_CONTENT_WEIGHT = 0.55;
export const FURNITURE_DIGIT_SHARE_FOR_PAGE_NUMBER = 0.6;
export const PROBE_CROSS_DECIMAL_PLACES = 6;

/** 单页也可确定识别的页码必须完全落在页底 8% 带内，正文数字不得越过这道门。 */
export const LOCAL_PAGE_NUMBER_EDGE_BAND_SHARE = 0.08;

/** 单页页码还必须落在左右外侧或页面中央的对称带内，排除页底表格中的普通数字。 */
export const LOCAL_PAGE_NUMBER_HORIZONTAL_ZONE_SHARE = 0.18;

/** 页码只接受短纯数字；更长数字更可能是日期、编号或正文数据。 */
export const LOCAL_PAGE_NUMBER_MAX_CHARACTERS = 4;

/** 页底纯数字有位置与词法两份证据，但缺少跨页重复证据，置信度低于 L2 聚类。 */
export const LOCAL_PAGE_NUMBER_CONFIDENCE = 0.86;

/** 续接只看紧邻页边的正文对象；距离太远不能说明跨页悬挂。 */
export const CONTINUATION_EDGE_BAND_SHARE = 0.12;
export const CONTINUATION_MIN_TEXT_CHARACTERS = 2;
export const CONTINUATION_PARAGRAPH_CONFIDENCE = 0.72;
export const CONTINUATION_LIST_CONFIDENCE = 0.78;
export const CONTINUATION_TABLE_CONFIDENCE = 0.84;
export const CONTINUATION_TERMINAL_PUNCTUATION = /[。！？.!?;；:：]$/u;
export const CONTINUATION_LIST_PREFIX = /^\s*(?:[-*•▪◦]|\(?\d+[.)、]|[（(]?[一二三四五六七八九十]+[）)、.])/u;

/** 页尾英文续接常把短名词短语留在上一页；拆分只认末尾 2–4 词的冠词短语。 */
export const CONTINUATION_TRAILING_PHRASE = /\b(?:the|a|an)\s+\S+(?:\s+\S+){1,3}$/iu;

/** 拆分前缀必须仍有足够正文，避免把本来完整的短行切成碎片。 */
export const CONTINUATION_SPLIT_MIN_PREFIX_CHARACTERS = 8;

/** 只拆近似水平文字；旋转基线的比例分 bbox 会产生错误坐标。 */
export const CONTINUATION_SPLIT_ROTATION_TOLERANCE_RATIO = 0.01;
