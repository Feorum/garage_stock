import { useEffect, useRef, useState } from 'preact/hooks';
import { isOwnerOrderDetail, resolveRoute } from './navigation.js';
import type { Profile } from './workspace-types';

interface DrawerEntry {
  session: string;
  origin: string;
  depth: number;
}

export function useWorkspaceRoute(role: Profile['role']) {
  function currentHash() {
    const hash = location.hash;
    if (role === 'admin' && /^#(?:orders\/tools|shift\/attention)(?:\?|$)/.test(hash)) {
      const journal = hash.replace(/^#[^?]+/, '#orders');
      history.replaceState(null, '', journal);
      return journal;
    }
    return hash;
  }
  const [hash, setHash] = useState(currentHash);
  const current = useRef(hash);
  const [session] = useState(() => crypto.randomUUID());
  const entry = useRef<DrawerEntry>({ session, origin: '#orders', depth: 0 });
  const closing = useRef(false);
  const positions = useRef(new Map<string, number>());

  useEffect(() => {
    function readHash() {
      const from = current.current;
      const next = currentHash();
      if (from === next) return;
      positions.current.set(from, window.scrollY);
      const target = resolveRoute(role, next);
      if (role === 'admin' && isOwnerOrderDetail(target.id, target.record)) {
        const saved = history.state?.garageDrawer as DrawerEntry | undefined;
        if (saved?.session === session) {
          // Back and Forward revisit the same history entry, including nested editors.
          entry.current = saved;
        } else {
          const prior = resolveRoute(role, from);
          if (isOwnerOrderDetail(prior.id, prior.record)) {
            const previous = entry.current;
            entry.current = { ...previous, depth: previous.depth > 0 ? previous.depth + 1 : 0 };
          } else if (prior.id === 'orders' && (prior.record === 'new' || prior.record === 'custom-new')) {
            entry.current = { session, origin: '#orders', depth: 0 };
          } else {
            entry.current = { session, origin: from, depth: 1 };
          }
          history.replaceState({ ...history.state, garageDrawer: entry.current }, '');
        }
      }
      closing.current = false;
      current.current = next;
      setHash(next);
    }
    window.addEventListener('hashchange', readHash);
    return () => window.removeEventListener('hashchange', readHash);
  }, [role, session]);

  function dismiss() {
    if (closing.current) return;
    if (entry.current.depth) {
      closing.current = true;
      history.go(-entry.current.depth);
      return;
    }
    // A direct link, a reload, or a freshly created order has no list to pop to.
    history.replaceState(null, '', '#orders');
    current.current = '#orders';
    setHash('#orders');
  }
  return { hash, origin: entry.current.origin, positions: positions.current, dismiss };
}
