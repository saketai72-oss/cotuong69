const apiBaseUrl = (import.meta.env.VITE_API_URL || 'http://localhost:5000/api')
  .replace(/\/+$/, '');

export async function fetchMatch(matchId, { signal } = {}) {
  const response = await fetch(`${apiBaseUrl}/matches/${encodeURIComponent(matchId)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });

  const match = await response.json();
  if (!response.ok) {
    throw new Error(match.error || `Không thể tải trận đấu (${response.status})`);
  }

  return match;
}
