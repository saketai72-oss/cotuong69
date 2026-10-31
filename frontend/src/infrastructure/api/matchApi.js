import { TokenStorage } from '../storage/tokenStorage.js';
import { buildAuthHeaders, buildWsProtocols } from './wsAuth.js';

// FE-09: mặc định dùng đường dẫn tương đối (dev đi qua proxy của Vite)
const apiBaseUrl = (import.meta.env?.VITE_API_URL || '/api').replace(/\/+$/, '');

export function apiOrigin() {
  if (/^https?:\/\//i.test(apiBaseUrl)) return apiBaseUrl;
  const origin = typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost:3000';
  return `${origin}${apiBaseUrl.startsWith('/') ? '' : '/'}${apiBaseUrl}`;
}

// FE-08: lỗi mang theo mã HTTP để hook quyết định có nên thử lại hay không
export class MatchApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'MatchApiError';
    this.status = status;
  }
}

export function matchWebSocketUrl(matchId) {
  const url = new URL(`${apiOrigin()}/matches/${encodeURIComponent(matchId)}/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

// WS roomHub (/ws/room/:code) cho game, chat và signaling khi URL có roomCode.
// Dev đi qua proxy /ws của Vite; nếu VITE_API_URL là domain tuyệt đối thì dùng origin của nó.
export function roomWebSocketUrl(roomCode) {
  const origin = /^https?:\/\//i.test(apiBaseUrl)
    ? new URL(apiBaseUrl).origin
    : (typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost:3000');
  const url = new URL(`${origin}/ws/room/${encodeURIComponent(roomCode)}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

// FE-06: subprotocol mang token (không đưa token vào query string)
export function matchWebSocketProtocols() {
  return buildWsProtocols(TokenStorage.getAccessToken());
}

export async function fetchMatch(matchId, { signal } = {}) {
  const response = await fetch(`${apiOrigin()}/matches/${encodeURIComponent(matchId)}`, {
    method: 'GET',
    // FE-06: gắn Bearer token nếu đã đăng nhập
    headers: { Accept: 'application/json', ...buildAuthHeaders(TokenStorage.getAccessToken()) },
    signal,
  });

  // FE-08: kiểm tra content-type trước khi .json() (proxy/server lỗi có thể trả HTML)
  const contentType = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-type') || ''
    : 'application/json';
  let match = null;
  if (/json/i.test(contentType)) {
    try {
      match = await response.json();
    } catch {
      match = null;
    }
  }
  if (!response.ok) {
    throw new MatchApiError(
      (match && match.error) || `Không thể tải trận đấu (${response.status})`,
      response.status,
    );
  }
  if (!match || typeof match !== 'object') {
    throw new MatchApiError('Máy chủ trả về dữ liệu trận đấu không hợp lệ.', response.status);
  }

  return match;
}
