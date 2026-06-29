import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/lib/auth';
import { t } from '@/lib/i18n';
import { useLocale } from '@/lib/i18n-context';
import type { Locale } from '@/lib/i18n';
import { apiFetch } from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { Menu, Moon, Sun, LogOut, User, Shield, Settings } from 'lucide-react';
import { GlobalSearch } from '@/components/search/GlobalSearch';

interface TopbarProps {
  onMenuToggle: () => void;
  darkMode: boolean;
  onDarkModeToggle: () => void;
}

export function Topbar({ onMenuToggle, darkMode, onDarkModeToggle }: TopbarProps) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const { locale, setLocale } = useLocale();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  async function handleLogout() {
    try {
      await apiFetch('/admin/v1/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    // Clear all cached data (including customer PII) before navigating away
    queryClient.clear();
    logout();
    navigate('/login');
  }

  return (
    <header className="sticky top-0 z-30 h-14 border-b border-border bg-card/80 backdrop-blur flex items-center px-4 gap-3">
      {/* Left zone: hamburger (mobile only) */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onMenuToggle}
          className="lg:hidden inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('layout', 'openMenu')}
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {/* Center zone: inline global search input */}
      <div className="flex-1 flex justify-center px-2">
        <GlobalSearch />
      </div>

      <label className="sr-only" htmlFor="locale-switcher">
        {t('layout', 'language')}
      </label>
      <select
        id="locale-switcher"
        aria-label={t('layout', 'language')}
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="h-9 rounded-md border border-input bg-transparent px-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="en">EN</option>
        <option value="fr">FR</option>
      </select>

      <button
        type="button"
        onClick={onDarkModeToggle}
        className="inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {darkMode ? (
          <Sun className="h-5 w-5" aria-hidden="true" />
        ) : (
          <Moon className="h-5 w-5" aria-hidden="true" />
        )}
      </button>

      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          className="inline-flex items-center gap-2 rounded-md p-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <User className="h-5 w-5" aria-hidden="true" />
          <span className="hidden sm:inline max-w-[120px] truncate">
            {user?.name ?? user?.email}
          </span>
        </button>

        {menuOpen && (
          <div
            className="absolute right-0 mt-2 w-56 rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-1"
            role="menu"
          >
            <div className="px-3 py-2 text-sm border-b border-border mb-1">
              <p className="font-medium truncate">{user?.name ?? user?.email}</p>
              <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
              <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <Shield className="h-3 w-3" aria-hidden="true" />
                <span className="capitalize">{user?.role}</span>
              </div>
            </div>
            <Link
              to="/settings"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              role="menuitem"
            >
              <Settings className="h-4 w-4" aria-hidden="true" />
              {t('layout', 'settings')}
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              className="w-full flex items-center gap-2 rounded-sm px-3 py-2 text-sm text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              role="menuitem"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              {t('auth', 'logout')}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
