import { useEffect, useState } from 'react';
import { fetchMatch } from '../../infrastructure/api/matchApi';

export function useMatch(matchId) {
  const [state, setState] = useState({ match: null, loading: true, error: null });

  useEffect(() => {
    if (!matchId) {
      return undefined;
    }

    let cancelled = false;
    let timeoutId;
    let controller;

    async function refreshMatch() {
      controller = new AbortController();

      try {
        const match = await fetchMatch(matchId, { signal: controller.signal });
        if (!cancelled) {
          setState({ match, loading: false, error: null });
        }
      } catch (error) {
        if (!cancelled && error.name !== 'AbortError') {
          setState((current) => ({
            ...current,
            loading: false,
            error: error.message || 'Không thể kết nối tới máy chủ trận đấu.',
          }));
        }
      } finally {
        if (!cancelled) {
          timeoutId = window.setTimeout(refreshMatch, 1000);
        }
      }
    }

    refreshMatch();

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      controller?.abort();
    };
  }, [matchId]);

  return state;
}
