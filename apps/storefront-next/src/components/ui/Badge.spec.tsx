import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge, badgeClasses } from './Badge';

describe('Badge', () => {
  it('always renders its text label (colour is never the sole signal)', () => {
    render(<Badge tone="success">In stock</Badge>);
    expect(screen.getByText('In stock')).toBeInTheDocument();
  });

  it('the availability variant uses inline colour-text tokens (matches the PDP)', () => {
    render(
      <Badge variant="availability" tone="success">
        In stock
      </Badge>,
    );
    const el = screen.getByText('In stock');
    expect(el.className).toContain('text-success');
    expect(el.className).toContain('text-xs');
    // No pill background/border for the availability variant (visual parity with prior PDP markup).
    expect(el.className).not.toContain('rounded-full');
  });

  it('maps the destructive tone to the destructive token', () => {
    render(
      <Badge variant="availability" tone="destructive">
        Out of stock
      </Badge>,
    );
    expect(screen.getByText('Out of stock').className).toContain('text-destructive');
  });

  it('renders a solid pill variant with token bg/foreground', () => {
    expect(badgeClasses('solid', 'success')).toContain('bg-success');
    expect(badgeClasses('solid', 'success')).toContain('text-success-foreground');
    expect(badgeClasses('solid', 'primary')).toContain('rounded-full');
  });

  it('renders an outline pill variant', () => {
    expect(badgeClasses('outline', 'muted')).toContain('border-border');
    expect(badgeClasses('outline', 'muted')).toContain('rounded-full');
  });

  it('merges a caller className (e.g. the PDP ms-2 spacing)', () => {
    render(
      <Badge variant="availability" tone="success" className="ms-2">
        In stock
      </Badge>,
    );
    expect(screen.getByText('In stock').className).toContain('ms-2');
  });
});
