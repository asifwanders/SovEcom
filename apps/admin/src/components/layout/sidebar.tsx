import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n-context';
import { useAuthStore } from '@/lib/auth';
import { can, type Permission } from '@/lib/permissions';
import { useGroupState } from '@/hooks/use-group-state';
import { NavGroup } from './nav-group';
import {
  LayoutDashboard,
  Package,
  Tags,
  FileText,
  FolderTree,
  Users,
  UserCog,
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
  LayoutTemplate,
  Boxes,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
} from 'lucide-react';
import { SovEcomLogo } from '@/components/icons';

// `label` takes the reactive `t` (from useT) so nav labels re-render on a locale
// switch. Typed as the exact `t` returned by useT.
type ReactiveT = ReturnType<typeof useT>['t'];

interface NavItemDef {
  to: string;
  label: (t: ReactiveT) => string;
  icon: typeof LayoutDashboard;
  permission: Permission | null;
}

/** All group definitions. Order and membership match the spec. */
const GROUP_DEFS: {
  id: string;
  groupLabel: (t: ReactiveT) => string;
  items: NavItemDef[];
}[] = [
  {
    id: 'overview',
    groupLabel: (t) => t('layout', 'groupOverview'),
    items: [
      {
        to: '/dashboard',
        label: (t) => t('layout', 'dashboard'),
        icon: LayoutDashboard,
        permission: null,
      },
    ],
  },
  {
    id: 'catalog',
    groupLabel: (t) => t('layout', 'groupCatalog'),
    items: [
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
    ],
  },
  {
    id: 'orders',
    groupLabel: (t) => t('layout', 'groupOrders'),
    items: [
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
        to: '/disputes',
        label: (t) => t('layout', 'disputes'),
        icon: Gavel,
        permission: 'orders:read',
      },
    ],
  },
  {
    id: 'customers',
    groupLabel: (t) => t('layout', 'groupCustomers'),
    items: [
      { to: '/customers', label: (t) => t('layout', 'customers'), icon: Users, permission: null },
    ],
  },
  {
    id: 'marketing',
    groupLabel: (t) => t('layout', 'groupMarketing'),
    items: [
      {
        to: '/discounts',
        label: (t) => t('layout', 'discounts'),
        icon: Ticket,
        permission: 'settings:read',
      },
      {
        to: '/analytics',
        label: (t) => t('layout', 'analytics'),
        icon: BarChart3,
        permission: 'settings:read',
      },
    ],
  },
  {
    id: 'storefront',
    groupLabel: (t) => t('layout', 'groupStorefront'),
    items: [
      {
        to: '/themes',
        label: (t) => t('layout', 'themes'),
        icon: Palette,
        permission: 'themes:read',
      },
      {
        to: '/home-sections',
        label: (t) => t('layout', 'homeSections'),
        icon: LayoutTemplate,
        permission: 'themes:write',
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
    ],
  },
  {
    id: 'settings',
    groupLabel: (t) => t('layout', 'groupSettings'),
    items: [
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
        to: '/email-log',
        label: (t) => t('layout', 'emailLog'),
        icon: Mail,
        permission: 'orders:read',
      },
      {
        to: '/business-identity',
        label: (t) => t('layout', 'businessIdentity'),
        icon: Building2,
        permission: 'settings:write',
      },
      {
        to: '/audit-log',
        label: (t) => t('layout', 'auditLog'),
        icon: ClipboardList,
        permission: 'audit_log:export',
      },
      {
        to: '/staff',
        label: (t) => t('layout', 'staff'),
        icon: UserCog,
        permission: 'users:read',
      },
      { to: '/settings', label: (t) => t('layout', 'settings'), icon: Settings, permission: null },
    ],
  },
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

  // Filter groups: drop items the user cannot see, drop empty groups.
  const visibleGroups = GROUP_DEFS.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.permission === null || can(role, item.permission)),
  })).filter((group) => group.items.length > 0);

  const allGroupIds = visibleGroups.map((g) => g.id);

  // Find which group contains the active route so we can auto-expand it.
  const activeGroupId = visibleGroups.find((g) =>
    g.items.some((item) => location.pathname.startsWith(item.to)),
  )?.id;

  const { openGroups, toggle, expandAll, collapseAll } = useGroupState();

  // On every navigation or reload, show ONLY the group that contains the active route —
  // all other groups collapse. Manual opens (toggle) last until the next navigation.
  useEffect(() => {
    expandAll(activeGroupId ? [activeGroupId] : []);
  }, [location.pathname, activeGroupId, expandAll]);

  const allOpen = allGroupIds.every((id) => openGroups.has(id));

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

        {/* Expand all / Collapse all — only when sidebar is not icon-rail */}
        {!collapsed && (
          <div className="flex justify-end px-3 pt-2 pb-0.5">
            <button
              type="button"
              onClick={() => (allOpen ? collapseAll() : expandAll(allGroupIds))}
              className={cn(
                'flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-muted-foreground',
                'rounded px-1.5 py-0.5 transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
              title={allOpen ? t('layout', 'collapseAll') : t('layout', 'expandAll')}
            >
              <ChevronsUpDown className="h-3 w-3" aria-hidden="true" />
              <span>{allOpen ? t('layout', 'collapseAll') : t('layout', 'expandAll')}</span>
            </button>
          </div>
        )}

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0" aria-label="Main navigation">
          {visibleGroups.map((group) => {
            const isOpen = openGroups.has(group.id);
            const hasActive = group.items.some((item) => location.pathname.startsWith(item.to));

            const resolvedItems = group.items.map((item) => ({
              to: item.to,
              label: item.label(t),
              Icon: item.icon,
              active: location.pathname.startsWith(item.to),
            }));

            return (
              <NavGroup
                key={group.id}
                id={group.id}
                label={group.groupLabel(t)}
                items={resolvedItems}
                isOpen={isOpen}
                sidebarCollapsed={collapsed}
                hasActive={hasActive}
                onToggle={() => toggle(group.id)}
                onItemClick={onMobileClose}
              />
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
