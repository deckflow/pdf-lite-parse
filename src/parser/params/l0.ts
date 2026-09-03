/** 间接引用或资源图超过这个深度，通常意味着成环或恶意构造。 */
export const L0_MAX_REFERENCE_DEPTH = 64;

/** 页树允许比普通文档宽松得多，但必须给畸形输入一个确定的停止点。 */
export const L0_MAX_PAGE_TREE_DEPTH = 128;

/** 增量保存产生的 /Prev 链通常很短；上限用于阻止循环 xref 链。 */
export const L0_MAX_XREF_SECTIONS = 64;

/** 单个对象流的对象数上限，避免伪造 /N 导致无界循环。 */
export const L0_MAX_OBJECT_STREAM_OBJECTS = 100_000;

/** 页树或对象表的工作量上限；L0 失败后主解析仍会继续。 */
export const L0_MAX_STRUCTURAL_OBJECTS = 1_000_000;
