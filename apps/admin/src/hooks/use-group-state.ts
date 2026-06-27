/**
 * Persists sidebar group open/closed state to localStorage so the sidebar
 * remembers its layout across page loads.
 *
 * Returns a tuple [openGroups, toggle, expandAll, collapseAll] where:
 *   - openGroups: Set<string> of currently open group ids
 *   - toggle(id): toggle one group
 *   - setOpen(id, open): set a group to a specific state
 *   - expandAll(ids): open all groups
 *   - collapseAll(ids): close all groups
 */
import { useState, useCallback } from 'react';

const STORAGE_KEY = 'sovecom.admin.sidebar.groups';

function readStored(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed as string[]);
    }
  } catch {
    // ignore
  }
  return new Set<string>();
}

function persist(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // best-effort
  }
}

export function useGroupState(defaultOpen?: string[]) {
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const stored = readStored();
    // If nothing stored yet, open the defaults
    if (stored.size === 0 && defaultOpen?.length) {
      return new Set(defaultOpen);
    }
    return stored;
  });

  const toggle = useCallback((id: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persist(next);
      return next;
    });
  }, []);

  const setOpen = useCallback((id: string, open: boolean) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      persist(next);
      return next;
    });
  }, []);

  const expandAll = useCallback((ids: string[]) => {
    setOpenGroups(() => {
      const next = new Set(ids);
      persist(next);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setOpenGroups(() => {
      const next = new Set<string>();
      persist(next);
      return next;
    });
  }, []);

  return { openGroups, toggle, setOpen, expandAll, collapseAll };
}
