import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { createMockApi } from '../test-utils';
import { PROGRESS_KEY, TOKEN_KEY } from '../wizard/storage';

// jsdom: stub createObjectURL/revokeObjectURL (used by the logo preview) + location.assign.
beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign: () => {} },
  });
  if (!('createObjectURL' in URL)) {
    // @ts-expect-error jsdom stub
    URL.createObjectURL = () => 'blob:logo';
    // @ts-expect-error jsdom stub
    URL.revokeObjectURL = () => {};
  } else {
    URL.createObjectURL = () => 'blob:logo';
    URL.revokeObjectURL = () => {};
  }
});

/** Seed progress directly onto the Brand step (index 1) with a live token. */
function seedBrand() {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ currentIndex: 1, data: {} }));
  sessionStorage.setItem(TOKEN_KEY, 'good-token');
}

describe('BrandStep', () => {
  it('renders the colour pickers, logo upload, and gradient toggle', async () => {
    seedBrand();
    const { api } = createMockApi();
    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: /your brand/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/primary colour$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/secondary colour$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/logo \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /gradient/i })).toBeInTheDocument();
  });

  it('rejects an unsupported file type inline and does not keep it', async () => {
    seedBrand();
    const { api } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /your brand/i });

    const file = new File(['x'], 'malware.exe', { type: 'application/octet-stream' });
    // userEvent.upload honours the input's `accept` filter (so a non-image never reaches
    // our handler). To exercise our OWN client-side type guard — the real defence, since a
    // user can rename/spoof — drive the change directly with a non-matching file.
    const input = screen.getByLabelText(/logo \(optional\)/i) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/file type isn’t supported/i)).toBeInTheDocument();
    expect(screen.queryByAltText(/logo preview/i)).not.toBeInTheDocument();
  });

  it('rejects an oversized file inline', async () => {
    seedBrand();
    const user = userEvent.setup();
    const { api } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /your brand/i });

    const big = new File([new Uint8Array(6 * 1024 * 1024)], 'huge.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText(/logo \(optional\)/i), big);

    expect(await screen.findByText(/larger than 5 mb/i)).toBeInTheDocument();
  });

  it('shows a preview for a valid logo', async () => {
    seedBrand();
    const user = userEvent.setup();
    const { api } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /your brand/i });

    const png = new File(['x'], 'logo.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText(/logo \(optional\)/i), png);

    expect(await screen.findByAltText(/logo preview/i)).toBeInTheDocument();
  });

  it('blocks Continue with an inline error when a colour hex is invalid', async () => {
    seedBrand();
    const user = userEvent.setup();
    const { api, postMultipart } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /your brand/i });

    const primary = screen.getByLabelText(/primary colour$/i);
    await user.clear(primary);
    await user.type(primary, 'not-a-hex');
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(await screen.findByText(/hex colour like/i)).toBeInTheDocument();
    expect(postMultipart).not.toHaveBeenCalled();
  });

  it('posts multipart with the logo and colours, then advances', async () => {
    seedBrand();
    const user = userEvent.setup();
    const { api, postMultipart } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /your brand/i });

    const png = new File(['x'], 'logo.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText(/logo \(optional\)/i), png);
    await screen.findByAltText(/logo preview/i);

    await user.click(screen.getByRole('switch', { name: /gradient/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => expect(postMultipart).toHaveBeenCalled());
    const [path, form] = postMultipart.mock.calls[0]!;
    expect(path).toBe('/setup/v1/brand');
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get('logo')).toBeInstanceOf(File);
    expect((form as FormData).get('gradient')).toBe('true');
    expect((form as FormData).get('primary')).toBe('#00B9A0');

    // Advanced to step 3 (Database).
    expect((await screen.findAllByText(/step 3 of 11/i)).length).toBeGreaterThan(0);
  });

  it('continues with defaults (no logo) — logo is optional', async () => {
    seedBrand();
    const user = userEvent.setup();
    const { api, postMultipart } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /your brand/i });

    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => expect(postMultipart).toHaveBeenCalled());
    const form = postMultipart.mock.calls[0]![1] as FormData;
    expect(form.get('logo')).toBeNull();
    expect((await screen.findAllByText(/step 3 of 11/i)).length).toBeGreaterThan(0);
  });
});
