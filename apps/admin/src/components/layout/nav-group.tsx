/**
 * NavGroup — a collapsible sidebar section.
 *
 * Renders a labelled button (the group header) followed by an animated list of
 * nav links. Fully accessible: aria-expanded, aria-controls, role="group".
 *
 * The height transition uses a CSS custom property trick so it works without
 * the Radix Accordion dependency.
 */
import { useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface NavItem {
  to: string;
  label: string;
  Icon: React.ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;
  active: boolean;
}

interface NavGroupProps {
  id: string;
  label: string;
  items: NavItem[];
  isOpen: boolean;
  /** True when collapsed to icon-rail mode (sidebar fully collapsed). */
  sidebarCollapsed: boolean;
  /** Whether any item in this group is active (for collapsed-state indicator). */
  hasActive: boolean;
  onToggle: () => void;
  onItemClick: () => void;
}

export function NavGroup({
  id,
  label,
  items,
  isOpen,
  sidebarCollapsed,
  hasActive,
  onToggle,
  onItemClick,
}: NavGroupProps) {
  const panelId = `nav-group-panel-${id}`;
  const headerId = `nav-group-header-${id}`;

  // Animate the panel height with a ref so we avoid re-renders on every frame.
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    if (isOpen) {
      el.style.maxHeight = `${el.scrollHeight}px`;
    } else {
      el.style.maxHeight = '0px';
    }
  }, [isOpen, items.length]);

  // When sidebar is fully collapsed to icon-rail, render items as a flat icon
  // column with no group header (matching icon-rail UX).
  if (sidebarCollapsed) {
    return (
      <div className="py-1">
        {items.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            onClick={onItemClick}
            className={cn(
              'flex items-center justify-center rounded-md p-2 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              item.active
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
            aria-current={item.active ? 'page' : undefined}
            title={item.label}
          >
            <item.Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
          </Link>
        ))}
      </div>
    );
  }

  return (
    <div className="py-1">
      {/* Group header button */}
      <button
        id={headerId}
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={onToggle}
        className={cn(
          'group flex w-full items-center justify-between rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wider',
          'text-muted-foreground/70 hover:text-foreground transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          // Subtle primary tint when collapsed but contains active route
          !isOpen && hasActive && 'text-primary',
        )}
      >
        <span>{label}</span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 transition-transform duration-200',
            isOpen && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      {/* Collapsible item panel */}
      <div
        id={panelId}
        ref={panelRef}
        role="group"
        aria-labelledby={headerId}
        className="overflow-hidden transition-[max-height] duration-200 ease-in-out"
        style={{ maxHeight: isOpen ? undefined : '0px' }}
      >
        <div className="mt-0.5 space-y-0.5">
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={onItemClick}
              // Indented (pl-6) to read as children of the open group, and a notch smaller
              // (text-[11px]) than the uppercase group heading (text-xs) above them.
              className={cn(
                'flex items-center gap-2.5 rounded-md py-1.5 pr-3 pl-6 text-[11px] font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                item.active
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
              aria-current={item.active ? 'page' : undefined}
            >
              <item.Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{item.label}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
