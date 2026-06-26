/**
 * D2 — Input/Select accessible error wiring:
 * aria-invalid, error message rendered, aria-describedby points at the message.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Input } from '../input';
import { Select } from '../select';

describe('Input (D2 aria-invalid)', () => {
  it('sets aria-invalid and renders an error message when error is provided', () => {
    render(<Input error="Required field" aria-describedby="input-error" />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Required field')).toBeInTheDocument();
  });

  it('does not set aria-invalid when there is no error', () => {
    render(<Input />);
    const input = screen.getByRole('textbox');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('error message element id is referenced by aria-describedby', () => {
    render(<Input id="field1" error="Bad input" />);
    const input = screen.getByRole('textbox');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const errorEl = document.getElementById(describedBy!);
    expect(errorEl).toHaveTextContent('Bad input');
  });
});

describe('Select (D2 aria-invalid)', () => {
  it('sets aria-invalid and renders an error message when error is provided', () => {
    render(
      <Select error="Please select" aria-describedby="select-error">
        <option value="">Pick one</option>
      </Select>,
    );
    const select = screen.getByRole('combobox');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Please select')).toBeInTheDocument();
  });

  it('does not set aria-invalid when there is no error', () => {
    render(
      <Select>
        <option value="">Pick one</option>
      </Select>,
    );
    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-invalid');
  });
});
