/**
 * Bare-name → whole-variant ranking unit tests (AI assistant product lookup).
 *
 * Grounds the «Г/П НАПОЛЕОН (ЦЕЛЫЙ)» preference: a bare "napoleon" (Latin) must
 * rank the canonical whole Cyrillic cake ahead of flavour / half / other cakes.
 */
import { describe, expect, it } from 'vitest';
import { parseProductName, bareNameRank } from '../src/lib/productNameRank.js';

describe('parseProductName', () => {
  it('splits prefix, core and trailing qualifier', () => {
    expect(parseProductName('Г/П НАПОЛЕОН (ЦЕЛЫЙ)')).toEqual({
      core: 'НАПОЛЕОН',
      qualifier: 'целый',
      isWhole: true,
    });
  });

  it('marks non-whole portions and flavours as not whole', () => {
    expect(parseProductName('Г/П НАПОЛЕОН (ПОЛОВИНА)').isWhole).toBe(false);
    expect(parseProductName('Г/П НАПОЛЕОН (КАРАМЕЛЬНО)').isWhole).toBe(false);
    expect(parseProductName('Г/П НАПОЛЕОН (КАРАМЕЛЬНО)').qualifier).toBe('карамельно');
  });

  it('strips the З/Г (заготовка) prefix too', () => {
    expect(parseProductName('З/Г КОРЖ НАПОЛЕОН (ЦЕЛЫЙ)').core).toBe('КОРЖ НАПОЛЕОН');
  });

  it('keeps the core when there is no qualifier', () => {
    expect(parseProductName('Г/П НАПОЛЕОН')).toEqual({
      core: 'НАПОЛЕОН',
      qualifier: '',
      isWhole: false,
    });
  });

  it('reads only the LAST parenthetical as the portion qualifier', () => {
    const p = parseProductName('Г/П НАПОЛЕОН (КВ) (ЦЕЛЫЙ)');
    expect(p.core).toBe('НАПОЛЕОН (КВ)');
    expect(p.isWhole).toBe(true);
  });
});

describe('bareNameRank', () => {
  it('ranks the Cyrillic whole variant first for a Latin bare query', () => {
    const names = [
      'Г/П НАПОЛЕОН (КАРАМЕЛЬНО)',
      'Г/П НАПОЛЕОН АВГАНСКИЙ (ЦЕЛЫЙ)',
      'Г/П НАПОЛЕОН (ЦЕЛЫЙ)',
      'Г/П НАПОЛЕОН (ПОЛОВИНА)',
    ];
    const ranked = [...names].sort(
      (a, b) => bareNameRank(a, 'napoleon') - bareNameRank(b, 'napoleon'),
    );
    expect(ranked[0]).toBe('Г/П НАПОЛЕОН (ЦЕЛЫЙ)');
  });

  it('orders whole < unqualified < portion < flavour < longer-core', () => {
    expect(bareNameRank('Г/П НАПОЛЕОН (ЦЕЛЫЙ)', 'napoleon')).toBe(0);
    expect(bareNameRank('Г/П НАПОЛЕОН', 'napoleon')).toBe(1);
    expect(bareNameRank('Г/П НАПОЛЕОН (ПОЛОВИНА)', 'napoleon')).toBe(2);
    expect(bareNameRank('Г/П НАПОЛЕОН (КАРАМЕЛЬНО)', 'napoleon')).toBe(3);
    expect(bareNameRank('Г/П НАПОЛЕОН АВГАНСКИЙ (ЦЕЛЫЙ)', 'napoleon')).toBe(4);
  });

  it('a Cyrillic bare query behaves identically', () => {
    expect(bareNameRank('Г/П НАПОЛЕОН (ЦЕЛЫЙ)', 'наполеон')).toBe(0);
    expect(bareNameRank('Г/П НАПОЛЕОН (КАРАМЕЛЬНО)', 'наполеон')).toBe(3);
  });
});
