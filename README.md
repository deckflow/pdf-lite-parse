# pdf-lite-parse

轻量、离线的 PDF 解析器，将数字型 PDF 转换为结构化 JSON 和 Markdown。提供 Node.js API 和命令行工具，无需模型、OCR 服务或 API Key。

支持原生文本、表格、分栏、标题、列表、图片、批注及大纲，并保留内容的来源定位。必选运行时依赖只有 `pdfjs-dist`；可选的 `@napi-rs/canvas` 用于复合图裁剪，缺失时会明确降级。

## 从源码构建

需要 **Node.js ≥ 22.18** 和 npm。

```bash
npm ci
npm run typecheck
npm run build
node dist/parser/cli.js document.pdf --out ./out --render
```

构建会生成 JavaScript、TypeScript 声明和 JSON Schema，不需要额外的数据文件或环境配置。

生成并安装本地 npm 包：

```bash
npm pack
npm install -g ./pdf-lite-parse-0.1.0.tgz
pdf-lite-parse document.pdf --out ./out --render
```

当前版本为 `0.1.0`，尚未发布到 npm。只需要基础解析能力时，可使用 `npm ci --omit=optional` 安装依赖。

## 命令行

```bash
pdf-lite-parse parse report.pdf --out out/report --render
pdf-lite-parse convert report.pdf -o report.md
pdf-lite-parse convert out/report/result.json -o report.md
pdf-lite-parse check-determinism report.pdf
```

省略子命令时默认为 `parse`。`convert` 接受 PDF 或已生成的 `result.json`，图片链接随 Markdown 输出位置调整。转换 JSON 时应保留其相邻资产目录。

| 选项 | 作用 |
|---|---|
| `--out <dir>` | 工件目录，默认 `<PDF名>.parsed` |
| `-o <file>` | `convert` 的 Markdown 输出文件 |
| `--password <pw>` | 加密 PDF 口令，不写入输出 |
| `--render` | 同时生成 Markdown |
| `--page-furniture off\|drop\|extract` | 页眉页脚保留、从正文排除或单独提取，默认 `off` |
| `--overlaid-text auto\|keep\|drop` | 图内文字合成、独立保留或移除，默认 `auto` |
| `--debug` | 保存中间解析结果 |
| `--include-source-path` | 在结果中包含源文件绝对路径 |
| `--no-isolate` | 对可信输入关闭子进程隔离和资源限额 |

默认启用页级失败隔离和资源限额。新结果通过校验后才替换已有工件；拒绝覆盖输入文件和非工件目录。

退出码：`0` 表示完成（可能有降级页）；`1` 表示页面失败、资源超限或结果校验失败；`2` 表示参数、文档打开或渲染错误。

## Node.js API

安装构建后的包，即可使用：

```ts
import { parse, parseArtifacts, toMarkdown } from 'pdf-lite-parse';

const result = await parse('report.pdf'); // 也接受 Uint8Array 或 Buffer
const markdown = toMarkdown(result);

const artifacts = await parseArtifacts('report.pdf', {
  pageFurniture: 'extract',
});
// 图片路径是逻辑相对路径，对应字节可从 assets 获取。
for (const [path, bytes] of artifacts.assets) {
  // 将 bytes 保存到自己的输出目录。
}
```

`ParseOptions` 支持 `password`、`pageFurniture`、`overlaidText`、`isolate` 和 `includeSourcePath`。`parse` 返回 `result.v3` 文档；`toMarkdown` 返回字符串，结果缺少必要字段时抛出错误。TypeScript 类型随包提供，JSON Schema 可通过 `pdf-lite-parse/schemas/result` 等子路径读取。

CLI 默认输出 `result.json`、`warnings.json`、`metadata.json`、`source_index.json` 和 `assets/`；`--render` 或 `convert` 增加 `output.md`。库接口自动清理临时文件，需要图片时使用 `parseArtifacts`。

## 能力边界

扫描页不做 OCR；文本层不完整、矢量图片无法导出或版面不确定时，会尽力保留内容并告警。复杂论文中的上标引用、短元数据行顺序及表头角色判断仍可能不准确。公式保留可提取原文，不生成 LaTeX。

批处理应检查 `pages[].status` 和 `warnings`。源对象覆盖率不等于文本识别率，也不能证明全部结构语义正确。

## 开发与许可证

仓库只维护运行源码、构建配置和使用说明。GitHub Actions 在 Node.js 22.18 和 24 上执行类型检查、构建与打包。修改代码后运行 `npm run typecheck` 和 `npm pack`；发布包仅包含运行文件、类型声明、Schema 与许可证。

采用 [Apache-2.0](LICENSE) 许可证；来源与第三方声明见 [NOTICE](NOTICE)。
