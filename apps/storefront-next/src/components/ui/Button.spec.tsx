import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { Button, buttonClasses } from './Button';

describe('Button', () => {
  it('renders a native <button> with type="button" by default', () => {
    render(<Button>Click</Button>);
    const btn = screen.getByRole('button', { name: 'Click' });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
  });

  it('applies the primary token classes (no hardcoded colour)', () => {
    render(<Button variant="primary">Go</Button>);
    const btn = screen.getByRole('button', { name: 'Go' });
    expect(btn.className).toContain('bg-primary');
    expect(btn.className).toContain('text-primary-foreground');
    expect(btn.className).toContain('hover:bg-primary-hover');
  });

  it('applies the secondary (bordered) token classes', () => {
    render(<Button variant="secondary">Go</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('border-input');
    expect(btn.className).toContain('bg-transparent');
  });

  it('exposes a visible focus ring via the --ring token', () => {
    render(<Button>Go</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('focus-visible:ring-2');
    expect(btn.className).toContain('focus-visible:ring-ring');
  });

  it('maps sizes to the exact shipped heights/padding', () => {
    expect(buttonClasses('primary', 'sm')).toContain('h-9');
    expect(buttonClasses('primary', 'md')).toContain('h-10');
    expect(buttonClasses('secondary', 'lg')).toContain('px-6');
  });

  it('honours an explicit type and the disabled state', () => {
    render(
      <Button type="submit" disabled>
        Submit
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    expect(btn).toHaveAttribute('type', 'submit');
    expect(btn).toBeDisabled();
    expect(btn.className).toContain('disabled:opacity-50');
  });

  it('renders an <a> when as="a" (for CTAs) and forwards href', () => {
    render(
      <Button as="a" href="/products">
        Shop
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Shop' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/products');
  });

  it('forwards onClick and a ref to the button element', () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <Button ref={ref} onClick={onClick}>
        Tap
      </Button>,
    );
    screen.getByRole('button').click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});
