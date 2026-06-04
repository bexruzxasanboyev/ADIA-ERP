import { describe, it, expect } from 'vitest';
import { classifyRecipeStage, groupRecipeByStage } from './recipeStage';
import { RECIPE_STAGE_ORDER } from './labels';
import type { RecipeNode } from './types';

function node(name: string, total_cost: number | null = null): RecipeNode {
  return {
    component_product_id: Math.floor(Math.random() * 1e6),
    name,
    type: 'raw',
    unit: 'kg',
    qty_per_unit: 1,
    brutto: null,
    netto: null,
    unit_cost: null,
    line_cost: total_cost,
    total_cost,
    children: [],
  };
}

describe('classifyRecipeStage', () => {
  it('routes dough ingredients (Latin + Cyrillic)', () => {
    expect(classifyRecipeStage('Мука высший сорт')).toBe('dough');
    expect(classifyRecipeStage('Shakar')).toBe('dough');
    expect(classifyRecipeStage('Бисквит шоколадный')).toBe('dough');
    expect(classifyRecipeStage('Tuxum')).toBe('dough');
  });

  it('routes cream ingredients', () => {
    expect(classifyRecipeStage('Крем сливочный')).toBe('cream');
    expect(classifyRecipeStage('Sariyog')).toBe('cream');
    expect(classifyRecipeStage('Сгущёнка')).toBe('cream');
  });

  it('routes decoration ingredients and wins over cream on overlap', () => {
    expect(classifyRecipeStage('Глазурь шоколадная')).toBe('decoration');
    expect(classifyRecipeStage('Посыпка')).toBe('decoration');
    expect(classifyRecipeStage('Декор мастика')).toBe('decoration');
  });

  it('falls back to other for unknown names', () => {
    expect(classifyRecipeStage('Коробка картонная')).toBe('other');
  });
});

describe('groupRecipeByStage', () => {
  it('partitions top-level nodes in canonical order and drops empty groups', () => {
    const groups = groupRecipeByStage(
      [node('Крем', 100), node('Мука', 50), node('Декор', 25)],
      RECIPE_STAGE_ORDER,
    );
    expect(groups.map((g) => g.stage)).toEqual(['dough', 'cream', 'decoration']);
  });

  it('sums subtotals and yields null when a group has no known cost', () => {
    const groups = groupRecipeByStage(
      [node('Мука', 50), node('Shakar', 30), node('Крем', null)],
      RECIPE_STAGE_ORDER,
    );
    const dough = groups.find((g) => g.stage === 'dough');
    const cream = groups.find((g) => g.stage === 'cream');
    expect(dough?.subtotal).toBe(80);
    expect(cream?.subtotal).toBeNull();
  });
});
