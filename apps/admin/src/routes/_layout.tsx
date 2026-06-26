import { Outlet } from 'react-router-dom';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { useAuthStore } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import React from 'react';
import { cn } from '@/lib/utils';

export default function AuthenticatedLayout() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setUser = useAuthStore((s) => s.setUser);

  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [darkMode, setDarkMode] = React.useState(false);

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  // Bootstrap /me on first load
  React.useEffect(() => {
    if (!isAuthenticated) return;
    apiFetch<{ id: string; email: string; name: string; role: string; totpEnabled: boolean }>(
      '/admin/v1/auth/me',
    )
      .then((data) => {
        setUser({
          id: data.id,
          email: data.email,
          name: data.name,
          role: data.role,
          totpEnabled: data.totpEnabled,
        });
      })
      .catch(() => {
        // If /me fails, the apiFetch interceptor will handle 401 and redirect
      });
  }, [isAuthenticated, setUser]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />
      <div
        className={cn(
          'flex flex-col min-h-screen transition-all duration-200',
          sidebarCollapsed ? 'lg:ml-[72px]' : 'lg:ml-[240px]',
        )}
      >
        <Topbar
          onMenuToggle={() => setMobileOpen(!mobileOpen)}
          darkMode={darkMode}
          onDarkModeToggle={() => setDarkMode(!darkMode)}
        />
        <main className="flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
