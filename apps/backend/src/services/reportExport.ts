/**
 * Report export service — turns a `Report` value object (see `reports.ts`)
 * into a downloadable file in three formats: Excel (.xlsx), Word (.docx) and
 * PDF. Each `toXlsx` / `toDocx` / `toPdf` returns `{ buffer, filename }` ready
 * for Grammy `replyWithDocument(new InputFile(buffer, filename))`.
 *
 * The three exporters share ONE input shape, so a report defined once renders
 * identically everywhere: a title, a subtitle, and titled sections, each a
 * header row + data rows + an optional total row.
 *
 * Libraries (added to @adia/backend): `exceljs`, `docx`, `pdfkit`.
 *
 * Text is Uzbek (UI language). PDF uses the built-in Helvetica family (WinAnsi)
 * — the report strings use straight apostrophes and em-dashes, which render
 * correctly; no embedded font file is required.
 */
import ExcelJS from 'exceljs';
import {
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import PDFDocument from 'pdfkit';
import type { Report, ReportSection } from './reports.js';

/** What every exporter returns. */
export type ExportFile = {
  readonly buffer: Buffer;
  readonly filename: string;
};

export type ExportFormat = 'xlsx' | 'pdf' | 'docx';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['xlsx', 'pdf', 'docx'];

const EXT: Readonly<Record<ExportFormat, string>> = {
  xlsx: 'xlsx',
  pdf: 'pdf',
  docx: 'docx',
};

/** A stable, safe filename: `<slug>_<YYYYMMDD>.<ext>`. */
function buildFilename(report: Report, format: ExportFormat): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeSlug = report.slug.replace(/[^a-z0-9_]+/gi, '_');
  return `${safeSlug}_${stamp}.${EXT[format]}`;
}

// ---------------------------------------------------------------------------
// Excel (.xlsx) — exceljs
// ---------------------------------------------------------------------------

export async function toXlsx(report: Report): Promise<ExportFile> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ADIA ERP';
  wb.created = new Date();
  const ws = wb.addWorksheet('Hisobot');

  // Title block.
  ws.addRow([report.title]);
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.addRow([report.subtitle]);
  ws.getRow(2).font = { italic: true, size: 10 };
  ws.addRow([]);

  for (const section of report.sections) {
    const headingRow = ws.addRow([section.heading]);
    headingRow.font = { bold: true, size: 12 };

    const header = ws.addRow([...section.columns]);
    header.font = { bold: true };
    header.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFEFEFEF' },
      };
      cell.border = { bottom: { style: 'thin' } };
    });

    for (const row of section.rows) {
      ws.addRow([...row]);
    }
    if (section.total !== undefined) {
      const totalRow = ws.addRow([...section.total]);
      totalRow.font = { bold: true };
      totalRow.eachCell((cell) => {
        cell.border = { top: { style: 'thin' } };
      });
    }
    ws.addRow([]);
  }

  // Auto-ish column widths from the longest cell in each column.
  autoSizeColumns(ws);

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    filename: buildFilename(report, 'xlsx'),
  };
}

function autoSizeColumns(ws: ExcelJS.Worksheet): void {
  const widths: number[] = [];
  ws.eachRow((row) => {
    row.eachCell((cell, colNumber) => {
      const len = cell.value == null ? 0 : String(cell.value).length;
      widths[colNumber - 1] = Math.max(widths[colNumber - 1] ?? 0, len);
    });
  });
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = Math.min(60, Math.max(10, w + 2));
  });
}

// ---------------------------------------------------------------------------
// Word (.docx) — docx
// ---------------------------------------------------------------------------

export async function toDocx(report: Report): Promise<ExportFile> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: report.title, bold: true })],
    }),
    new Paragraph({
      children: [new TextRun({ text: report.subtitle, italics: true, size: 20 })],
    }),
    new Paragraph({ text: '' }),
  ];

  for (const section of report.sections) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: section.heading, bold: true })],
      }),
    );
    children.push(buildDocxTable(section));
    children.push(new Paragraph({ text: '' }));
  }

  const doc = new Document({
    creator: 'ADIA ERP',
    title: report.title,
    sections: [{ children }],
  });

  const buffer = await Packer.toBuffer(doc);
  return { buffer, filename: buildFilename(report, 'docx') };
}

function buildDocxTable(section: ReportSection): Table {
  const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
  const cellBorders = {
    top: border,
    bottom: border,
    left: border,
    right: border,
  };

  const headerRow = new TableRow({
    tableHeader: true,
    children: section.columns.map(
      (c) =>
        new TableCell({
          borders: cellBorders,
          shading: { fill: 'EFEFEF' },
          children: [new Paragraph({ children: [new TextRun({ text: c, bold: true })] })],
        }),
    ),
  });

  const dataRows = section.rows.map(
    (row) =>
      new TableRow({
        children: row.map(
          (cell) =>
            new TableCell({
              borders: cellBorders,
              children: [new Paragraph({ text: cell })],
            }),
        ),
      }),
  );

  const allRows = [headerRow, ...dataRows];
  if (section.total !== undefined) {
    allRows.push(
      new TableRow({
        children: section.total.map(
          (cell) =>
            new TableCell({
              borders: cellBorders,
              children: [
                new Paragraph({ children: [new TextRun({ text: cell, bold: true })] }),
              ],
            }),
        ),
      }),
    );
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: allRows,
  });
}

// ---------------------------------------------------------------------------
// PDF (.pdf) — pdfkit
// ---------------------------------------------------------------------------

export async function toPdf(report: Report): Promise<ExportFile> {
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      // Title + subtitle.
      doc.font('Helvetica-Bold').fontSize(18).text(report.title);
      doc.moveDown(0.2);
      doc.font('Helvetica-Oblique').fontSize(10).fillColor('#555').text(report.subtitle);
      doc.fillColor('#000');
      doc.moveDown(0.8);

      for (const section of report.sections) {
        doc.font('Helvetica-Bold').fontSize(13).text(section.heading);
        doc.moveDown(0.3);
        renderPdfTable(doc, section);
        doc.moveDown(0.8);
      }
      doc.end();
    } catch (err) {
      reject(err as Error);
    }
  });

  return { buffer, filename: buildFilename(report, 'pdf') };
}

/**
 * A simple fixed-grid table: equal column widths across the printable area,
 * a shaded header, thin row separators, a bold total row. Wraps cell text and
 * tracks the tallest cell so rows never overlap. Adds a page break when the
 * cursor nears the bottom margin.
 */
function renderPdfTable(
  doc: PDFKit.PDFDocument,
  section: ReportSection,
): void {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const tableWidth = right - left;
  const colCount = section.columns.length;
  const colWidth = tableWidth / colCount;
  const padX = 4;
  const padY = 4;
  const fontSize = 9;

  const drawRow = (
    cells: readonly string[],
    opts: { bold: boolean; shaded: boolean; topLine: boolean },
  ): void => {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
    // Measure the tallest cell so multi-line text fits.
    let rowHeight = 0;
    for (let i = 0; i < colCount; i += 1) {
      const text = cells[i] ?? '';
      const h = doc.heightOfString(text, { width: colWidth - padX * 2 });
      rowHeight = Math.max(rowHeight, h);
    }
    rowHeight += padY * 2;

    // Page break if needed.
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }
    const y = doc.y;

    if (opts.shaded) {
      doc.rect(left, y, tableWidth, rowHeight).fill('#EFEFEF');
      doc.fillColor('#000');
    }
    if (opts.topLine) {
      doc
        .moveTo(left, y)
        .lineTo(right, y)
        .lineWidth(0.5)
        .strokeColor('#999')
        .stroke();
    }

    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor('#000');
    for (let i = 0; i < colCount; i += 1) {
      const text = cells[i] ?? '';
      doc.text(text, left + i * colWidth + padX, y + padY, {
        width: colWidth - padX * 2,
      });
    }
    // Bottom separator.
    doc
      .moveTo(left, y + rowHeight)
      .lineTo(right, y + rowHeight)
      .lineWidth(0.3)
      .strokeColor('#DDD')
      .stroke();
    doc.y = y + rowHeight;
    doc.x = left;
  };

  drawRow(section.columns, { bold: true, shaded: true, topLine: false });
  for (const row of section.rows) {
    drawRow(row, { bold: false, shaded: false, topLine: false });
  }
  if (section.total !== undefined) {
    drawRow(section.total, { bold: true, shaded: false, topLine: true });
  }
}

// ---------------------------------------------------------------------------
// Dispatch — build any format by name
// ---------------------------------------------------------------------------

export function exportReport(
  report: Report,
  format: ExportFormat,
): Promise<ExportFile> {
  switch (format) {
    case 'xlsx':
      return toXlsx(report);
    case 'docx':
      return toDocx(report);
    case 'pdf':
      return toPdf(report);
  }
}

export function isExportFormat(v: string): v is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(v);
}
