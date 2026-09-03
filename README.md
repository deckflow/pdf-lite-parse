# pdf-lite-parse

A lightweight, offline PDF parser that converts PDFs with native text into structured JSON and Markdown. Available as a Node.js API and a command-line tool. No models, OCR services, or API keys are required.

Extract text, tables, columns, headings, lists, images, annotations, and document outlines while preserving references to the source content. The only required runtime dependency is `pdfjs-dist`. The optional `@napi-rs/canvas` dependency enables composite figure cropping; when unavailable, affected output is marked as degraded with a warning.

## Installation

Requires **Node.js 22.18 or later** and npm.

Install the library in your project:

```bash
npm install pdf-lite-parse
```

Or install the command-line tool globally:

```bash
npm install -g pdf-lite-parse
pdf-lite-parse document.pdf --out ./out --render
```

## Build from source

From a checkout of this repository:

```bash
npm ci
npm run typecheck
npm run build
node dist/parser/cli.js document.pdf --out ./out --render
```

The build generates JavaScript, TypeScript declarations, and JSON Schema files. No additional data files or environment configuration are needed.

Create a local npm package and install the CLI:

```bash
npm pack
npm install -g ./pdf-lite-parse-0.1.0.tgz
pdf-lite-parse document.pdf --out ./out --render
```

For basic parsing without composite figure cropping, install dependencies with `npm ci --omit=optional`.

## Command-line usage

```bash
pdf-lite-parse parse report.pdf --out out/report --render
pdf-lite-parse convert report.pdf -o report.md
pdf-lite-parse convert out/report/result.json -o report.md
pdf-lite-parse check-determinism report.pdf
```

The default command is `parse`. The `convert` command accepts a PDF or an existing `result.json` and adjusts image links for the Markdown output location. When converting JSON, keep the associated `assets/` directory alongside it.

| Option | Description |
|---|---|
| `--out <dir>` | Output directory; defaults to `<pdf-name>.parsed`. |
| `-o <file>` | Markdown output file for `convert`. |
| `--password <pw>` | Password for an encrypted PDF; never written to output. |
| `--render` | Also generate Markdown. |
| `--page-furniture off\|drop\|extract` | Keep headers and footers, remove them from body text, or extract them separately; defaults to `off`. |
| `--overlaid-text auto\|keep\|drop` | Automatically combine text with figures, keep it separately, or drop it; defaults to `auto`. |
| `--debug` | Save intermediate parsing results. |
| `--include-source-path` | Include the absolute source file path in the result. |
| `--no-isolate` | Disable child-process isolation and resource limits for trusted inputs. |

Page-level failure isolation and resource limits are enabled by default. Existing output is replaced only after the new result passes validation. The parser refuses to overwrite the input file or directories that are not recognized as parser output.

Exit codes: `0` indicates completion, which may include degraded pages; `1` indicates a page failure, resource limit violation, or result validation failure; `2` indicates an argument, document opening, or rendering error.

## Node.js API

Install the package into your project:

```bash
npm install pdf-lite-parse
```

Then import the API using ES modules:

```ts
import { parse, parseArtifacts, toMarkdown } from 'pdf-lite-parse';

const result = await parse('report.pdf'); // Also accepts Uint8Array or Buffer.
const markdown = toMarkdown(result);

const artifacts = await parseArtifacts('report.pdf', {
  pageFurniture: 'extract',
});
// Asset keys are relative paths; values contain the image bytes.
for (const [path, bytes] of artifacts.assets) {
  // Save bytes at path within your output directory.
}
```

`ParseOptions` supports `password`, `pageFurniture`, `overlaidText`, `isolate`, and `includeSourcePath`. The `parse` function returns a `result.v3` document. The `toMarkdown` function returns a string and throws if required fields are missing. TypeScript declarations are included, and JSON Schema files are available through subpaths such as `pdf-lite-parse/schemas/result`.

CLI output includes `result.json`, `warnings.json`, `metadata.json`, `source_index.json`, and `assets/`. Parsing a PDF with `--render` or `convert` also generates `output.md`. The API cleans up its temporary files automatically; use `parseArtifacts` when you need image bytes as well as the document.

## Limitations

Scanned pages are not processed with OCR. When a text layer is incomplete, a vector figure cannot be exported, or a layout is ambiguous, the parser preserves as much content as possible and emits warnings. Superscript citations, the ordering of short metadata lines, and table header classification may be inaccurate in complex papers. Formulas retain their extractable source text; LaTeX is not generated.

For batch processing, check `pages[].status` and `warnings`. Source object coverage measures how much source content is accounted for; it does not measure text recognition accuracy or guarantee correct document structure.

## Development

This repository contains the runtime source, build configuration, and usage documentation. GitHub Actions runs type checking, builds, and packaging on Node.js 22.18 and 24. After making changes, run `npm run typecheck` and `npm pack`. The npm package includes runtime files, type declarations, schemas, the README, and license notices.

## License

Licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution and third-party notices.
