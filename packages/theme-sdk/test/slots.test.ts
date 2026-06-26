import { describe, it, expect } from 'vitest';
import { defineThemeSlots } from '../src/index.js';

describe('defineThemeSlots', () => {
  it('accepts valid lowercase-slug slots and returns a frozen array', () => {
    const slots = defineThemeSlots(['product-page', 'cart-drawer', 'footer']);
    expect(slots).toEqual(['product-page', 'cart-drawer', 'footer']);
    expect(Object.isFrozen(slots)).toBe(true);
  });

  it('accepts an empty list', () => {
    expect(defineThemeSlots([])).toEqual([]);
  });

  it('rejects a non-array input', () => {
    // @ts-expect-error — author passed a non-array
    expect(() => defineThemeSlots('product-page')).toThrow(/must be an array/);
  });

  it('rejects a bad slug (uppercase / underscore)', () => {
    expect(() => defineThemeSlots(['Product_Page'])).toThrow(/must be a lowercase slug/);
  });

  it('rejects a slug starting with a digit', () => {
    expect(() => defineThemeSlots(['1slot'])).toThrow(/must be a lowercase slug/);
  });

  it('rejects a duplicate slug', () => {
    expect(() => defineThemeSlots(['product-page', 'product-page'])).toThrow(
      /declared more than once/,
    );
  });
});
