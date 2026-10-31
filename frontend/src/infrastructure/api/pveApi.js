import { TokenStorage } from '../storage/tokenStorage.js';
import { buildAuthHeaders } from './wsAuth.js';
import { apiOrigin } from './matchApi.js';

/**
 * PVE-UI: client của API PvE thật (backend /api/pve/*). Mọi lỗi đều là PveApiError có
 * `status` (HTTP, 0 nếu không tới được máy chủ) và `code` (mã của backend hoặc NETWORK_ERROR...).
 * Trạng thái trận, nước máy đáp, kết quả đều do máy chủ quyết định.
 */
export class PveApiError extends Error {
  constructor(message, { status = 0, code = 'HTTP_ERROR' } = {}) {
    super(message);
    this.name = 'PveApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body, responseType = 'match') {
  const headers = { Accept: 'application/json', ...buildAuthHeaders(TokenStorage.getAccessToken()) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${apiOrigin()}/pve${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new PveApiError('Không kết nối được máy chủ. Hãy kiểm tra mạng và thử lại.', { status: 0, code: 'NETWORK_ERROR' });
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = response.status === 401
      ? 'Bạn cần đăng nhập để chơi với máy.'
      : (data && (data.error || data.message)) || `Máy chủ trả lỗi ${response.status}.`;
    throw new PveApiError(message, {
      status: response.status,
      code: (data && data.code) || (response.status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR'),
    });
  }
  const hasExpectedResponse = responseType === 'match'
    ? Boolean(data && data.match)
    : Boolean(data && Array.isArray(data.destinations));
  if (!data || typeof data !== 'object' || !hasExpectedResponse) {
    throw new PveApiError('Phản hồi từ máy chủ không hợp lệ.', { status: response.status, code: 'INVALID_RESPONSE' });
  }
  return data;
}

export function createPveApi() {
  return {
    getMatch: (matchId) => request('GET', `/matches/${encodeURIComponent(matchId)}`),
    /** from/to: { row, col } */
    submitMove: (matchId, from, to) => request('POST', `/matches/${encodeURIComponent(matchId)}/moves`, { from, to }),
    getLegalMoves: (matchId, from) => request(
      'POST',
      `/matches/${encodeURIComponent(matchId)}/legal-moves`,
      { from },
      'legalMoves',
    ),
    resign: (matchId) => request('POST', `/matches/${encodeURIComponent(matchId)}/resign`),
  };
}
