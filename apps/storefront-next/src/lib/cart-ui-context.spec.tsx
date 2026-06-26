import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CartUiProvider, useCartUi } from './cart-ui-context';

function Probe(): React.ReactElement {
  const { isOpen, open, close } = useCartUi();
  return (
    <div>
      <span data-testid="state">{isOpen ? 'open' : 'closed'}</span>
      <button onClick={open}>open</button>
      <button onClick={close}>close</button>
    </div>
  );
}

describe('cart-ui-context', () => {
  it('starts closed', () => {
    render(
      <CartUiProvider>
        <Probe />
      </CartUiProvider>,
    );
    expect(screen.getByTestId('state')).toHaveTextContent('closed');
  });

  it('open() opens and close() closes', () => {
    render(
      <CartUiProvider>
        <Probe />
      </CartUiProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByText('open'));
    });
    expect(screen.getByTestId('state')).toHaveTextContent('open');
    act(() => {
      fireEvent.click(screen.getByText('close'));
    });
    expect(screen.getByTestId('state')).toHaveTextContent('closed');
  });

  it('throws when used outside the provider (a wiring bug)', () => {
    // Silence the expected React error boundary console noise.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/useCartUi must be used within/);
    spy.mockRestore();
  });
});
