import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// The banner links to /privacy via the i18n Link; stub it to a plain anchor for the unit test.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

import { CookieBanner } from './CookieBanner';
import { ConsentProvider, useConsent, CONSENT_COOKIE, parseConsent } from '@/lib/consent';

/** A test-only trigger that re-opens the banner, mirroring the footer's "Manage cookies" button. */
function ManageTrigger() {
  const { openManage } = useConsent();
  return (
    <button type="button" onClick={openManage}>
      manage
    </button>
  );
}

function clearConsent() {
  document.cookie = `${CONSENT_COOKIE}=; path=/; max-age=0`;
}
function currentCookie(): string | undefined {
  return document.cookie
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${CONSENT_COOKIE}=`))
    ?.split('=')[1];
}

function renderBanner(locale: 'en' | 'fr' = 'en') {
  return renderWithIntl(
    <ConsentProvider>
      <CookieBanner />
    </ConsentProvider>,
    locale,
  );
}

beforeEach(() => clearConsent());
afterEach(() => clearConsent());

describe('CookieBanner', () => {
  it('renders the notice as a non-modal region when no consent cookie is present', () => {
    renderBanner();
    const region = screen.getByRole('region', { name: 'Cookie notice' });
    expect(region).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull(); // non-modal, no focus trap
    expect(screen.getByText('Privacy-friendly by design')).toBeInTheDocument();
  });

  it('does NOT render when a consent decision is already recorded', () => {
    document.cookie = `${CONSENT_COOKIE}=a0m0; path=/`;
    renderBanner();
    expect(screen.queryByRole('region', { name: 'Cookie notice' })).toBeNull();
  });

  it('Accept all records both categories on and unmounts', () => {
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'Accept all' }));
    expect(parseConsent(currentCookie())).toEqual({ analytics: true, marketing: true });
    expect(screen.queryByRole('region', { name: 'Cookie notice' })).toBeNull();
  });

  it('Save choices records only the ticked categories', () => {
    renderBanner();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Analytics' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save choices' }));
    expect(parseConsent(currentCookie())).toEqual({ analytics: true, marketing: false });
  });

  it('Reject (and the close button) record both categories off', () => {
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'Reject non-essential' }));
    expect(parseConsent(currentCookie())).toEqual({ analytics: false, marketing: false });
    expect(screen.queryByRole('region', { name: 'Cookie notice' })).toBeNull();
  });

  it('the close button is keyboard-operable and rejects', () => {
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss cookie notice' }));
    expect(parseConsent(currentCookie())).toEqual({ analytics: false, marketing: false });
  });

  it('stays hidden on a fresh render once a decision is persisted (returning visitor)', () => {
    document.cookie = `${CONSENT_COOKIE}=a1m0; path=/`;
    renderBanner();
    expect(screen.queryByRole('region', { name: 'Cookie notice' })).toBeNull();
  });

  it('links to the privacy page', () => {
    renderBanner();
    expect(screen.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute(
      'href',
      '/privacy',
    );
  });

  it('renders localized French copy', () => {
    renderBanner('fr');
    expect(screen.getByRole('region', { name: 'Avis relatif aux cookies' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tout accepter' })).toBeInTheDocument();
  });

  it('re-opens via Manage with checkboxes pre-filled from the recorded decision', () => {
    document.cookie = `${CONSENT_COOKIE}=a1m0; path=/`;
    renderWithIntl(
      <ConsentProvider>
        <CookieBanner />
        <ManageTrigger />
      </ConsentProvider>,
      'en',
    );
    // Hidden until re-opened.
    expect(screen.queryByRole('region', { name: 'Cookie notice' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'manage' }));
    expect(screen.getByRole('region', { name: 'Cookie notice' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Analytics' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Marketing' })).not.toBeChecked();
  });

  it('reloads the page when a re-opened decision REVOKES a granted category (downgrade)', () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload, protocol: 'http:' },
    });
    document.cookie = `${CONSENT_COOKIE}=a1m0; path=/`;
    renderWithIntl(
      <ConsentProvider>
        <CookieBanner />
        <ManageTrigger />
      </ConsentProvider>,
      'en',
    );
    fireEvent.click(screen.getByRole('button', { name: 'manage' }));
    // Turn analytics OFF (revoke) and save → downgrade → reload.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Analytics' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save choices' }));
    expect(parseConsent(currentCookie())).toEqual({ analytics: false, marketing: false });
    expect(reload).toHaveBeenCalled();
  });
});
