/**
 * Unit tests for Poster workshop (Цех) classification + dish↔prepack name
 * normalisation. Pure — no DB. Guards the owner's include/exclude split and the
 * name-match normalisation that drives enrichment coverage.
 */
import { describe, expect, it } from 'vitest';
import {
  isExcludedWorkshop,
  isProductionWorkshop,
  normalizeMatchName,
} from '../src/integrations/poster/workshopClassification.js';

describe('workshopClassification — include/exclude', () => {
  it('INCLUDES the real production «… отдел» departments', () => {
    for (const name of [
      'Торт отдел',
      'Песочный отдел',
      'Пирог отдел',
      'Наполеон отдел',
      'Сомса отдел',
      'Салаты отдел',
    ]) {
      expect(isProductionWorkshop(name)).toBe(true);
      expect(isExcludedWorkshop(name)).toBe(false);
    }
  });

  it('INCLUDES «Оформления отдел» (decoration/assembly — owner 2026-06-08)', () => {
    // Owner decision: «Оформления отдел» is now a production workshop.
    expect(isProductionWorkshop('Оформления отдел')).toBe(true);
    expect(isExcludedWorkshop('Оформления отдел')).toBe(false);
    // case/whitespace-insensitive too
    expect(isProductionWorkshop('  оформления   отдел ')).toBe(true);
  });

  it('INCLUDES the non-«отдел» production workshops', () => {
    for (const name of [
      'Основной ',
      'Полуфабрикаты',
      'Адиа Чак чак',
      'Чак чак',
      'Адиа Норын',
    ]) {
      expect(isProductionWorkshop(name)).toBe(true);
    }
  });

  it('EXCLUDES «Склад*» storage workshops', () => {
    for (const name of [
      'Склад Евро',
      'Склад Эклер',
      'Склад Тарт',
      'Склад Пекарь',
      'Склад Спец',
    ]) {
      expect(isExcludedWorkshop(name)).toBe(true);
    }
  });

  it('EXCLUDES display/dispatch + drinks areas (but NOT «Оформления отдел»)', () => {
    expect(isExcludedWorkshop('Витрина')).toBe(true);
    expect(isExcludedWorkshop('Кейтеринг')).toBe(true);
    expect(isExcludedWorkshop('холодные напитки')).toBe(true);
    // «Оформления отдел» is now production (owner 2026-06-08) — not excluded.
    expect(isExcludedWorkshop('Оформления отдел')).toBe(false);
  });

  it('EXCLUDES an empty / whitespace name (degenerate)', () => {
    expect(isExcludedWorkshop('')).toBe(true);
    expect(isExcludedWorkshop('   ')).toBe(true);
  });

  it('case/whitespace-insensitive', () => {
    expect(isExcludedWorkshop('  СКЛАД  ЕВРО ')).toBe(true);
    expect(isProductionWorkshop('  пирог   отдел ')).toBe(true);
  });
});

describe('workshopClassification — normalizeMatchName', () => {
  it('strips the Г/П prefix and the trailing portion suffix', () => {
    expect(normalizeMatchName(' Г/П ПИРОГ С ТВОРОГОМ КВ (ЦЕЛЫЙ)')).toBe(
      'ПИРОГ С ТВОРОГОМ КВ',
    );
    expect(normalizeMatchName('Г/П АРИНИ ИНИ (ЦЕЛЫЙ)')).toBe('АРИНИ ИНИ');
    expect(normalizeMatchName('Г/П КАПРИЗ (ПОЛОВИНА)')).toBe('КАПРИЗ');
    expect(normalizeMatchName('Г/П КУСОК ТОРТА (КУСОК)')).toBe('КУСОК ТОРТА');
  });

  it('strips a trailing flavour/variant/author parenthetical (matcher-gap fix)', () => {
    // Live `adia` cases that the old portion-only rule left UNMATCHED.
    expect(normalizeMatchName('Г/П САМСА (С МЯСОМ)')).toBe('САМСА');
    expect(normalizeMatchName('Г/П САМСА (ОВОЩНАЯ)')).toBe('САМСА');
    expect(normalizeMatchName('Г/П НАПОЛЕОН (ФИСТАШКОВЫЙ)')).toBe('НАПОЛЕОН');
    expect(normalizeMatchName(' Г/П ЧИЗКЕЙК (АРАБИКА)')).toBe('ЧИЗКЕЙК');
    expect(normalizeMatchName('Г/П КАРТОШКА (КЕЙК ПОПС)')).toBe('КАРТОШКА');
    expect(normalizeMatchName('Г/П ТОРТ (АХРОР АКА)')).toBe('ТОРТ');
    expect(normalizeMatchName('Г/П ПИРОГ КВ (КВ)')).toBe('ПИРОГ КВ');
  });

  it('all САМСА flavour variants normalise to the single base dish', () => {
    const base = normalizeMatchName('САМСА ');
    for (const v of [
      'Г/П САМСА (С МЯСОМ)',
      'Г/П САМСА (ОВОЩНАЯ)',
      'Г/П САМСА (БЕДАНА)',
      'Г/П САМСА (С ТЫКВОЙ) ',
    ]) {
      expect(normalizeMatchName(v)).toBe(base);
    }
  });

  it('strips up to TWO trailing parenthetical groups', () => {
    expect(normalizeMatchName('Г/П НАПОЛЕОН (КАРАМЕЛЬНО) (ЦЕЛЫЙ)')).toBe('НАПОЛЕОН');
  });

  it('keeps a non-trailing parenthetical inside the name', () => {
    // Only a TRAILING group is treated as a variant tag; an inner one stays.
    expect(normalizeMatchName('Г/П ТОРТ (МИНИ) АССОРТИ')).toBe('ТОРТ (МИНИ) АССОРТИ');
  });

  it('matches a prepack to its dish after normalisation (both sides)', () => {
    const prepack = normalizeMatchName(' Г/П ПИРОГ С ТВОРОГОМ КВ (ЦЕЛЫЙ)');
    const dish = normalizeMatchName('ПИРОГ С ТВОРОГОМ КВ ');
    expect(prepack).toBe(dish);
  });

  it('handles Г\\П and ГП prefix variants', () => {
    expect(normalizeMatchName('Г\\П ЖУЛЬЕН')).toBe('ЖУЛЬЕН');
    expect(normalizeMatchName('ГП ЖУЛЬЕН')).toBe('ЖУЛЬЕН');
  });

  it('returns empty string for a degenerate name', () => {
    expect(normalizeMatchName('Г/П')).toBe('');
    expect(normalizeMatchName('   ')).toBe('');
  });

  it('leaves an ordinary semi name untouched (uppercased, collapsed)', () => {
    expect(normalizeMatchName('напольеон  ун')).toBe('НАПОЛЬЕОН УН');
  });
});
