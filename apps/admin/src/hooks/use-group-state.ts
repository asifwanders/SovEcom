/**
 * In-memory open/closed state for the sidebar groups.
 *
 * Deliberately NOT persisted: on every reload or navigation the sidebar resets to
 * "only the active page's group open" (see Sidebar's effect). Manual opens last only
 * until the next navigation.
 *
 * Returns { openGroups, toggle, setOpen, expandAll, collapseAll }:
 *   - openGroups: Set<string> of currently open group ids
 *   - toggle(id): toggle one group
 *   - setOpen(id, open): set a group to a specific state
 *   - expandAll(ids): set the open set to exactly `ids` (also used to "open only the active group")
 *   - collapseAll(): close every group
 */
import { useState, useCallback } from 'react';

export function useGroupState() {
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set<string>());

  const toggle = useCallback((id: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setOpen = useCallback((id: string, open: boolean) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const expandAll = useCallback((ids: string[]) => {
    setOpenGroups(new Set(ids));
  }, []);

  const collapseAll = useCallback(() => {
    setOpenGroups(new Set<string>());
  }, []);

  return { openGroups, toggle, setOpen, expandAll, collapseAll };
}
