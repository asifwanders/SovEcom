import { describe, it, expect } from 'vitest';
import {
  readHeaderLayout,
  readCartAffordance,
  DEFAULT_HEADER_LAYOUT,
  DEFAULT_CART_AFFORDANCE,
} from './chrome-variants';

describe('readHeaderLayout', () => {
  it('reads a valid mega/simple value', () => {
    expect(readHeaderLayout({ 'header.layout': 'mega' })).toBe('mega');
    expect(readHeaderLayout({ 'header.layout': 'simple' })).toBe('simple');
  });

  it('falls back to simple for absent / null / undefined settings', () => {
    expect(readHeaderLayout({})).toBe('simple');
    expect(readHeaderLayout(null)).toBe('simple');
    expect(readHeaderLayout(undefined)).toBe('simple');
    expect(DEFAULT_HEADER_LAYOUT).toBe('simple');
  });

  it('falls back to simple for an unknown or wrong-typed value (defensive)', () => {
    expect(readHeaderLayout({ 'header.layout': 'fancy' })).toBe('simple');
    expect(readHeaderLayout({ 'header.layout': 42 })).toBe('simple');
    expect(readHeaderLayout({ 'header.layout': { x: 1 } })).toBe('simple');
  });
});

describe('readCartAffordance', () => {
  it('reads a valid drawer/page-link value', () => {
    expect(readCartAffordance({ 'cart.affordance': 'drawer' })).toBe('drawer');
    expect(readCartAffordance({ 'cart.affordance': 'page-link' })).toBe('page-link');
  });

  it('falls back to drawer for absent / null / undefined settings', () => {
    expect(readCartAffordance({})).toBe('drawer');
    expect(readCartAffordance(null)).toBe('drawer');
    expect(readCartAffordance(undefined)).toBe('drawer');
    expect(DEFAULT_CART_AFFORDANCE).toBe('drawer');
  });

  it('falls back to drawer for an unknown or wrong-typed value (defensive)', () => {
    expect(readCartAffordance({ 'cart.affordance': 'modal' })).toBe('drawer');
    expect(readCartAffordance({ 'cart.affordance': true })).toBe('drawer');
  });
});
