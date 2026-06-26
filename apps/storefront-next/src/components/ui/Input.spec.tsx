import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { Input } from './Input';

describe('Input', () => {
  it('renders a text input with token classes (no hardcoded colour)', () => {
    render(<Input aria-label="q" />);
    const input = screen.getByRole('textbox', { name: 'q' });
    expect(input.tagName).toBe('INPUT');
    expect(input.className).toContain('border-input');
    expect(input.className).toContain('bg-transparent');
  });

  it('exposes a visible focus ring via the --ring token', () => {
    render(<Input aria-label="q" />);
    expect(screen.getByRole('textbox').className).toContain('focus-visible:ring-ring');
  });

  it('associates with a <label htmlFor> via a forwarded id', () => {
    render(
      <>
        <label htmlFor="search">Query</label>
        <Input id="search" name="q" />
      </>,
    );
    // getByLabelText only resolves when the id/htmlFor association is correct.
    expect(screen.getByLabelText('Query')).toBeInTheDocument();
  });

  it('forwards name, placeholder, value changes and a ref', () => {
    const onChange = vi.fn();
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} name="q" placeholder="Search…" onChange={onChange} aria-label="q" />);
    const input = screen.getByRole('textbox', { name: 'q' });
    expect(input).toHaveAttribute('name', 'q');
    expect(input).toHaveAttribute('placeholder', 'Search…');
    fireEvent.change(input, { target: { value: 'tee' } });
    expect(onChange).toHaveBeenCalled();
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it('supports the disabled state', () => {
    render(<Input aria-label="q" disabled />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('merges a caller className alongside the token classes', () => {
    render(<Input aria-label="q" className="flex-1" />);
    const input = screen.getByRole('textbox');
    expect(input.className).toContain('flex-1');
    expect(input.className).toContain('border-input');
  });
});
