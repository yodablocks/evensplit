import { useCallback, useEffect, useRef, useState } from 'react';
import type { GroupSnapshot } from '../shared/types';
import { RequestError, api } from './api';

const POLL_MS = 3000;

/**
 * Loads a group and keeps it fresh: checks the group version every 3 seconds
 * (while the tab is visible) and on window focus, and refetches only when
 * the version changed.
 */
export function useGroup(groupId: string) {
  const [snapshot, setSnapshot] = useState<GroupSnapshot | null>(null);
  const [error, setError] = useState<RequestError | null>(null);
  const version = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getGroup(groupId);
      version.current = next.group.version;
      setSnapshot(next);
      setError(null);
    } catch (err) {
      setError(err as RequestError);
    }
  }, [groupId]);

  useEffect(() => {
    void refresh();

    const check = async () => {
      if (document.hidden) return;
      try {
        const latest = await api.getVersion(groupId);
        if (latest.version !== version.current) await refresh();
      } catch {
        // Offline for a moment: try again on the next tick.
      }
    };
    const timer = setInterval(check, POLL_MS);
    addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      removeEventListener('focus', check);
    };
  }, [groupId, refresh]);

  return { snapshot, error, refresh };
}
