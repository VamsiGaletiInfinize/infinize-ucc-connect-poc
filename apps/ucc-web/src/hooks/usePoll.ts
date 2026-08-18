import { useCallback, useEffect, useState } from 'react';

/**
 * Poll a loader on an interval and expose loading/error state.
 *
 * Realtime pushes drive the live console; list screens poll, which keeps them correct
 * even if a client misses an SSE frame.
 */
export function usePoll<T>(loader: () => Promise<T>, intervalMs = 4000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setData(await loader());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refresh();
    if (!intervalMs) return;
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, intervalMs]);

  return { data, error, loading, refresh };
}
