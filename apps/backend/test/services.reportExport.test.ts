/**
 * Report export service — `toXlsx` / `toDocx` / `toPdf` must each produce a
 * non-empty Buffer with the expected `<slug>_<YYYYMMDD>.<ext>` filename, and
 * the bytes must carry each format's magic signature (so we know the content
 * is a real document, not an empty stub). Pure unit tests — no DB, no Poster.
 */
import { describe, expect, it } from 'vitest';
import {
  exportReport,
  toDocx,
  toPdf,
  toXlsx,
} from '../src/services/reportExport.js';
import type { Report } from '../src/services/reports.js';

const SAMPLE: Report = {
  type: 'sales',
  title: 'Sotuvlar hisoboti — Haftalik',
  subtitle: 'Davr: 2026-06-01 — 2026-06-06',
  period: 'hafta',
  slug: 'sales_hafta',
  sections: [
    {
      heading: "Umumiy ko'rsatkichlar",
      columns: ["Ko'rsatkich", 'Qiymat'],
      rows: [
        ['Umumiy tushum', "1 234 567 so'm"],
        ['Cheklar soni', '42'],
      ],
    },
    {
      heading: "Do'konlar kesimida",
      columns: ["Do'kon", 'Tushum', 'Cheklar'],
      rows: [
        ["Do'kon A", "800 000 so'm", '25'],
        ["Do'kon B", "434 567 so'm", '17'],
      ],
      total: ['Jami', "1 234 567 so'm", '42'],
    },
  ],
};

const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, '');

describe('toXlsx', () => {
  it('produces a non-empty .xlsx buffer (ZIP/OOXML signature) with the slug filename', async () => {
    const { buffer, filename } = await toXlsx(SAMPLE);
    expect(buffer.length).toBeGreaterThan(0);
    expect(filename).toBe(`sales_hafta_${STAMP}.xlsx`);
    // .xlsx is a ZIP container — first two bytes are "PK".
    expect(buffer.slice(0, 2).toString('latin1')).toBe('PK');
  });
});

describe('toDocx', () => {
  it('produces a non-empty .docx buffer (ZIP/OOXML signature) with the slug filename', async () => {
    const { buffer, filename } = await toDocx(SAMPLE);
    expect(buffer.length).toBeGreaterThan(0);
    expect(filename).toBe(`sales_hafta_${STAMP}.docx`);
    expect(buffer.slice(0, 2).toString('latin1')).toBe('PK');
  });
});

describe('toPdf', () => {
  it('produces a non-empty .pdf buffer (%PDF- header) with the slug filename', async () => {
    const { buffer, filename } = await toPdf(SAMPLE);
    expect(buffer.length).toBeGreaterThan(0);
    expect(filename).toBe(`sales_hafta_${STAMP}.pdf`);
    expect(buffer.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('exportReport dispatch', () => {
  it('routes each format to its exporter', async () => {
    const xlsx = await exportReport(SAMPLE, 'xlsx');
    const docx = await exportReport(SAMPLE, 'docx');
    const pdf = await exportReport(SAMPLE, 'pdf');
    expect(xlsx.filename.endsWith('.xlsx')).toBe(true);
    expect(docx.filename.endsWith('.docx')).toBe(true);
    expect(pdf.filename.endsWith('.pdf')).toBe(true);
  });

  it('exports a 4-section combined sales report cleanly in all formats', async () => {
    const combined: Report = {
      type: 'sales',
      title: 'Sotuvlar hisoboti — Haftalik',
      subtitle: 'Davr: 2026-06-01 — 2026-06-06',
      period: 'hafta',
      slug: 'sales_hafta',
      sections: [
        SAMPLE.sections[0]!,
        SAMPLE.sections[1]!,
        {
          heading: "To'lov turlari",
          columns: ["To'lov turi", 'Summa', 'Ulush'],
          rows: [
            ['Naqd', "800 000 so'm", '64.8%'],
            ['Karta', "434 567 so'm", '35.2%'],
          ],
          total: ['Jami', "1 234 567 so'm", '100.0%'],
        },
        {
          heading: "Eng ko'p sotilgan mahsulotlar (TOP 20)",
          columns: ['#', 'Mahsulot', 'Miqdor', 'Tushum'],
          rows: [
            ['1', 'Napoleon', '5 pcs', "500 000 so'm"],
            ['2', 'Eclair', '10 pcs', "300 000 so'm"],
          ],
          total: ['', 'Jami', '15', "800 000 so'm"],
        },
      ],
    };
    const xlsx = await toXlsx(combined);
    const docx = await toDocx(combined);
    const pdf = await toPdf(combined);
    expect(xlsx.buffer.slice(0, 2).toString('latin1')).toBe('PK');
    expect(docx.buffer.slice(0, 2).toString('latin1')).toBe('PK');
    expect(pdf.buffer.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('handles a report with empty sections without throwing', async () => {
    const empty: Report = {
      type: 'belowmin',
      title: "Min'dan past mahsulotlar",
      subtitle: 'Sana: 2026-06-06 (0 ta pozitsiya)',
      period: null,
      slug: 'belowmin',
      sections: [
        {
          heading: "Min'dan past mahsulotlar",
          columns: ["Bo'lim", 'Mahsulot', 'Qoldiq', 'Min', 'Yetishmovchilik'],
          rows: [],
        },
      ],
    };
    const xlsx = await toXlsx(empty);
    const docx = await toDocx(empty);
    const pdf = await toPdf(empty);
    expect(xlsx.buffer.length).toBeGreaterThan(0);
    expect(docx.buffer.length).toBeGreaterThan(0);
    expect(pdf.buffer.length).toBeGreaterThan(0);
  });
});
