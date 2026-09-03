import type {
  ParseRawPageArtifact,
  ProbeDocumentArtifact,
  ProbePagesArtifact,
} from '../../../schema/artifacts.ts';
import { ARTIFACT_SCHEMA_VERSIONS } from '../../../schema/artifacts.ts';
import { PARTIAL_SCAN_MAX_TEXT_DENSITY, PARTIAL_SCAN_MIN_IMAGE_SHARE, PROBE_MEDIUM_UNCERTAINTY } from '../../params/l1.ts';
import {
  pageLayoutType,
  probeColumns,
  probeOtherSignals,
  probeTable,
  riskLevel,
  structuralUncertainty,
} from './page-evidence.ts';
import { inferLanguageProfile, probeTextLayer } from './text-layer.ts';

/** 阶段④：只读 L0 + parse_raw，逐页产生可检视证据；正常路径不调用任何模型。 */
export function probePages(
  rawPages: readonly ParseRawPageArtifact[],
  documentProbe: ProbeDocumentArtifact,
  documentLanguage: string | null,
): ProbePagesArtifact {
  const documentPages = new Map(documentProbe.pageProbes.map((page) => [page.page, page]));
  const language = inferLanguageProfile(rawPages, documentLanguage);
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSIONS.probePages,
    pages: rawPages.map((rawPage) => {
      const text = probeTextLayer(rawPage, documentPages.get(rawPage.page), language);
      const table = probeTable(rawPage);
      const columns = probeColumns(rawPage);
      const signals = probeOtherSignals(rawPage, table);
      if (text.verdict === 'trusted' && signals.imageAreaRatio >= PARTIAL_SCAN_MIN_IMAGE_SHARE
        && signals.textDensity <= PARTIAL_SCAN_MAX_TEXT_DENSITY) {
        text.verdict = 'partial';
        text.evidence.push({ kind: 'geometry', hardness: 'statistical', code: 'sparse_text_over_image',
          score: signals.imageAreaRatio, sourceObjectIds: rawPage.objects.filter(o => o.kind === 'image').map(o => o.id) });
      }
      const uncertainty = structuralUncertainty(text.verdict, columns, table, signals);
      return {
        page: rawPage.page,
        layoutType: pageLayoutType(columns, table, signals),
        textLayerVerdict: text.verdict,
        hasBrokenTextLayer: text.verdict === 'broken',
        hasOverlaidTextOnImage: signals.hasOverlaidTextOnImage,
        textDensity: signals.textDensity,
        columns: columns.columns,
        imageAreaRatio: signals.imageAreaRatio,
        hasTable: table.hasTable,
        tableKind: table.tableKind,
        hasFormula: signals.hasFormula,
        hasChart: signals.hasChart,
        hasRotatedText: signals.hasRotatedText,
        riskLevel: riskLevel(uncertainty),
        structuralUncertainty: uncertainty,
        recommendedEngines: recommendedEngines(text.verdict, uncertainty),
        evidence: text.evidence,
        tableConfidence: table.tableConfidence,
        gridClosure: table.gridClosure,
        cellTextHitRate: table.cellTextHitRate,
        columnSupport: table.columnSupport,
        alignmentEntropy: table.alignmentEntropy,
        anchorObjectIds: table.anchorObjectIds,
        gutterWidth: columns.gutterWidth,
        gutterPurity: columns.gutterPurity,
        columnStability: columns.columnStability,
        rotation: signals.rotation,
        hasImage: signals.hasImage,
        scanEffectivePpi: signals.scanEffectivePpi,
        hasLowResolutionScan: signals.hasLowResolutionScan,
        vectorDensity: signals.vectorDensity,
        hasMixedTextImage: signals.hasMixedTextImage,
        fontMappable: text.fontMappable,
      };
    }),
  };
}

function recommendedEngines(
  verdict: 'trusted' | 'partial' | 'broken' | 'absent',
  uncertainty: number,
): string[] {
  if (verdict === 'broken' || verdict === 'absent') return ['pdfjs', 'full_parser'];
  if (uncertainty >= PROBE_MEDIUM_UNCERTAINTY) return ['pdfjs', 'layout_oracle'];
  return ['pdfjs'];
}
