import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n-context';
import { useAuthStore } from '@/lib/auth';
import { can, type Permission } from '@/lib/permissions';
import {
  LayoutDashboard,
  Package,
  Tags,
  FileText,
  FolderTree,
  Users,
  ClipboardList,
  Settings,
  ShoppingCart,
  RotateCcw,
  Mail,
  Gavel,
  Building2,
  Ticket,
  Truck,
  Percent,
  Webhook,
  Palette,
  LayoutGrid,
  Boxes,
  BarChart3,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { SovEcomLogo } from '@/components/icons';

// `label` takes the reactive `t` (from useT) so nav labels re-render on a locale
// switch. Typed as the exact `t` returned by useT.
type ReactiveT = ReturnType<typeof useT>['t'];

const allNavItems: {
  to: string;
  label: (t: ReactiveT) => string;
  icon: typeof LayoutDashboard;
  permission: Permission | null;
}[] = [
  {
    to: '/dashboard',
    label: (t) => t('layout', 'dashboard'),
    icon: LayoutDashboard,
    permission: null,
  },
  { to: '/products', label: (t) => t('layout', 'products'), icon: Package, permission: null },
  {
    to: '/categories',
    label: (t) => t('layout', 'categories'),
    icon: FolderTree,
    permission: null,
  },
  { to: '/tags', label: (t) => t('layout', 'tags'), icon: Tags, permission: null },
  {
    to: '/pages',
    label: (t) => t('layout', 'pages'),
    icon: FileText,
    permission: 'pages:read',
  },
  {
    to: '/orders',
    label: (t) => t('layout', 'orders'),
    icon: ShoppingCart,
    permission: 'orders:read',
  },
  {
    to: '/returns',
    label: (t) => t('layout', 'returns'),
    icon: RotateCcw,
    permission: 'orders:read',
  },
  {
    to: '/email-log',
    label: (t) => t('layout', 'emailLog'),
    icon: Mail,
    permission: 'orders:read',
  },
  {
    to: '/disputes',
    label: (t) => t('layout', 'disputes'),
    icon: Gavel,
    permission: 'orders:read',
  },
  {
    to: '/discounts',
    label: (t) => t('layout', 'discounts'),
    icon: Ticket,
    permission: 'settings:read',
  },
  {
    to: '/shipping',
    label: (t) => t('layout', 'shipping'),
    icon: Truck,
    permission: 'settings:read',
  },
  {
    to: '/taxes',
    label: (t) => t('layout', 'taxes'),
    icon: Percent,
    permission: 'settings:read',
  },
  {
    to: '/webhooks',
    label: (t) => t('layout', 'webhooks'),
    icon: Webhook,
    permission: 'settings:read',
  },
  {
    to: '/themes',
    label: (t) => t('layout', 'themes'),
    icon: Palette,
    permission: 'themes:read',
  },
  {
    to: '/slots',
    label: (t) => t('layout', 'slots'),
    icon: LayoutGrid,
    permission: 'themes:read',
  },
  {
    to: '/modules',
    label: (t) => t('layout', 'modules'),
    icon: Boxes,
    permission: 'modules:read',
  },
  {
    to: '/analytics',
    label: (t) => t('layout', 'analytics'),
    icon: BarChart3,
    permission: 'settings:read',
  },
  { to: '/customers', label: (t) => t('layout', 'customers'), icon: Users, permission: null },
  // Audit log is only shown to owner/admin (audit_log:export gating is sufficient)
  {
    to: '/audit-log',
    label: (t) => t('layout', 'auditLog'),
    icon: ClipboardList,
    permission: 'audit_log:export',
  },
  {
    to: '/business-identity',
    label: (t) => t('layout', 'businessIdentity'),
    icon: Building2,
    permission: 'settings:write',
  },
  { to: '/settings', label: (t) => t('layout', 'settings'), icon: Settings, permission: null },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export function Sidebar({ collapsed, onToggle, mobileOpen, onMobileClose }: SidebarProps) {
  const location = useLocation();
  const { t } = useT();
  const role = useAuthStore((s) => s.user?.role ?? null);
  // UX-only: filter nav items by client-side permission. Server enforces real authz.
  const navItems = allNavItems.filter(
    (item) => item.permission === null || can(role, item.permission),
  );

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed top-0 left-0 z-50 h-full bg-card border-r border-border flex flex-col transition-all duration-200',
          collapsed ? 'w-[72px]' : 'w-[240px]',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
        aria-label="Main navigation"
      >
        {/* Header / Logo */}
        <div className="flex items-center h-14 px-4 border-b border-border shrink-0">
          <div
            className={cn('flex items-center gap-2 overflow-hidden', collapsed && 'justify-center')}
          >
            <SovEcomLogo className="h-6 w-6 text-primary shrink-0" aria-hidden="true" />
            {!collapsed && <span className="font-semibold text-foreground truncate">SovEcom</span>}
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-1">
          {navItems.map((item) => {
            const active = location.pathname.startsWith(item.to);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={onMobileClose}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  collapsed && 'justify-center',
                )}
                aria-current={active ? 'page' : undefined}
                title={collapsed ? item.label(t) : undefined}
              >
                <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                {!collapsed && <span className="truncate">{item.label(t)}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Collapse toggle (desktop only) */}
        <div className="border-t border-border p-2 hidden lg:block">
          <button
            type="button"
            onClick={onToggle}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              collapsed && 'justify-center',
            )}
            aria-label={collapsed ? t('layout', 'expandSidebar') : t('layout', 'collapseSidebar')}
            title={collapsed ? t('layout', 'expandSidebar') : t('layout', 'collapseSidebar')}
          >
            {collapsed ? (
              <ChevronRight className="h-5 w-5" aria-hidden="true" />
            ) : (
              <>
                <ChevronLeft className="h-5 w-5" aria-hidden="true" />
                <span className="truncate">{t('layout', 'collapseSidebar')}</span>
              </>
            )}
          </button>
        </div>
      </aside>
    </>
  );
}
