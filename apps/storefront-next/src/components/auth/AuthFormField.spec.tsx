import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthFormField } from './AuthFormField';

describe('AuthFormField', () => {
  it('ties the label to the input via htmlFor/id', () => {
    render(<AuthFormField id="email" label="Email address" />);
    const input = screen.getByLabelText('Email address');
    expect(input).toHaveAttribute('id', 'email');
  });

  it('associates the error text via aria-describedby + aria-invalid when invalid', () => {
    render(<AuthFormField id="email" label="Email" error="Bad email" />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'email-error');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('id', 'email-error');
    expect(alert).toHaveTextContent('Bad email');
  });

  it('sets neither aria-invalid nor aria-describedby when valid', () => {
    render(<AuthFormField id="email" label="Email" />);
    const input = screen.getByLabelText('Email');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does NOT let a caller-supplied aria-describedby clobber the error association', () => {
    // A future caller passing its own aria-describedby/aria-invalid must not break the error binding —
    // the computed error aria-* wins (spread order hardening).
    render(
      <AuthFormField
        id="email"
        label="Email"
        error="Bad email"
        aria-describedby="some-other-hint"
        aria-invalid={false}
      />,
    );
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-describedby', 'email-error');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });
});
