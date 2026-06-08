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

  it('EXCLUDES display/dispatch/decoration + drinks areas', () => {
    expect(isExcludedWorkshop('Витрина')).toBe(true);
    expect(isExcludedWorkshop('Кейтеринг')).toBe(true);
    expect(isExcludedWorkshop('Оформления отдел')).toBe(true);
    expect(isExcludedWorkshop('холодные напитки')).toBe(true);
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
