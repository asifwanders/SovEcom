/**
 * D1 — Dialog accessibility: focus trap, initial focus, focus restoration,
 * Escape key close, aria-labelledby/aria-describedby wiring.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog } from '../dialog';

function TestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Test title" description="Test description">
      <button>First</button>
      <button>Second</button>
    </Dialog>
  );
}

describe('Dialog (D1 accessibility)', () => {
  it('renders with role=dialog, aria-modal, aria-labelledby and aria-describedby', () => {
    render(<TestDialog open onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    const titleId = dialog.getAttribute('aria-labelledby');
    const descId = dialog.getAttribute('aria-describedby');
    expect(titleId).toBeTruthy();
    expect(descId).toBeTruthy();

    expect(document.getElementById(titleId!)).toHaveTextContent('Test title');
    expect(document.getElementById(descId!)).toHaveTextContent('Test description');
  });

  it('moves focus into the dialog on open', async () => {
    render(<TestDialog open onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    // First focusable element inside the dialog should receive focus
    const firstButton = screen.getByRole('button', { name: 'First' });
    await vi.waitFor(() => expect(document.activeElement).toBe(firstButton));
    expect(dialog).toContainElement(firstButton);
  });

  it('closes on Escape key', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<TestDialog open onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps focus: Tab cycles within the dialog', async () => {
    const user = userEvent.setup();
    render(<TestDialog open onClose={() => {}} />);
    const first = screen.getByRole('button', { name: 'First' });
    const second = screen.getByRole('button', { name: 'Second' });

    // Wait for initial focus
    await vi.waitFor(() => expect(document.activeElement).toBe(first));
    await user.tab();
    expect(document.activeElement).toBe(second);
    // Tab from last should wrap back to first
    await user.tab();
    expect(document.activeElement).toBe(first);
  });

  it('restores focus to trigger element on close', async () => {
    const user = userEvent.setup();

    function Wrapper() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button id="trigger" onClick={() => setOpen(true)}>
            Open
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="T">
            <button>Inside</button>
          </Dialog>
        </>
      );
    }

    const React = await import('react');
    render(<Wrapper />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    await vi.waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('renders nothing when closed', () => {
    render(<TestDialog open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
