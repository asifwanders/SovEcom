import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { Select } from './Select';

function options() {
  return (
    <>
      <option value="a">Alpha</option>
      <option value="b">Beta</option>
    </>
  );
}

describe('Select', () => {
  it('renders a native <select> with its options and token classes', () => {
    render(
      <Select aria-label="sort" defaultValue="a">
        {options()}
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'sort' }) as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.className).toContain('border-input');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['a', 'b']);
  });

  it('exposes a visible focus ring via the --ring token', () => {
    render(<Select aria-label="sort">{options()}</Select>);
    expect(screen.getByRole('combobox').className).toContain('focus-visible:ring-ring');
  });

  it('associates with a <label htmlFor> via a forwarded id', () => {
    render(
      <>
        <label htmlFor="sort">Sort</label>
        <Select id="sort" name="sort">
          {options()}
        </Select>
      </>,
    );
    expect(screen.getByLabelText('Sort')).toBeInTheDocument();
  });

  it('forwards name, change handler and a ref', () => {
    const onChange = vi.fn();
    const ref = createRef<HTMLSelectElement>();
    render(
      <Select ref={ref} name="sort" defaultValue="a" onChange={onChange} aria-label="sort">
        {options()}
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'sort' });
    expect(select).toHaveAttribute('name', 'sort');
    fireEvent.change(select, { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalled();
    expect(ref.current).toBeInstanceOf(HTMLSelectElement);
  });

  it('supports the disabled state', () => {
    render(
      <Select aria-label="sort" disabled>
        {options()}
      </Select>,
    );
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});
