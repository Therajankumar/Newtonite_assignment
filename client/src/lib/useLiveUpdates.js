import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { tokenStore } from '../api/client.js';
import { keys } from '../api/hooks.js';

/**
 * Subscribe to server-sent "item changed" hints and refresh affected queries. Events carry
 * only ids and versions; data is always refetched through the authorized API. List-level
 * refreshes are throttled so a burst of changes causes one refetch, not hundreds.
 */
export function useLiveUpdates(enabled) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const pending = useRef(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const source = new EventSource(`/api/events?token=${encodeURIComponent(tokenStore.get() ?? '')}`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false); // EventSource reconnects by itself

    source.addEventListener('item.changed', (e) => {
      const event = JSON.parse(e.data);
      const cached = qc.getQueryData(keys.item(event.itemId));
      if (cached && cached.version < event.version) qc.invalidateQueries({ queryKey: keys.item(event.itemId) });
      qc.invalidateQueries({ queryKey: keys.activity(event.itemId) });
      if (!pending.current) {
        pending.current = setTimeout(() => {
          pending.current = null;
          qc.invalidateQueries({ queryKey: ['items'] });
          qc.invalidateQueries({ queryKey: keys.dashboard });
          qc.invalidateQueries({ queryKey: keys.notifications });
        }, 1500);
      }
    });
    return () => {
      source.close();
      clearTimeout(pending.current);
      pending.current = null;
    };
  }, [enabled, qc]);

  return connected;
}
