const { URL } = require('node:url');
const { corsHeaders } = require('../../../core/cors');
const { sendError } = require('../utils/errorResponse');
const { AppError, ERROR_CODES } = require('../../../core/errors/AppError');
const PgUserRepository = require('../../../infrastructure/database/repositories/PgUserRepository');
const { authenticateRequestWithSession } = require('../middlewares/authMiddleware');
const { createPveService } = require('../../../application/use-cases/game/pve/pveService');

/**
 * FE-10: API chơi với máy (PvE). Tất cả đều yêu cầu đăng nhập và chỉ chủ trận mới thao tác được
 * (kiểm quyền trong use-case qua loadOwnedMatch).
 *
 *   POST /api/pve/matches                  { playerColor }   -> tạo trận (máy đi trước nếu bạn cầm Đen)
 *   GET  /api/pve/matches/:id                                -> trạng thái trận
 *   POST /api/pve/matches/:id/moves        { from, to }      -> đi quân, máy đi lại NGAY và trả cả hai nước
 *   POST /api/pve/matches/:id/resign                         -> xin thua
 *
 * Cố ý KHÔNG có endpoint "bot đi" hay "kiểm tra hết giờ": hai việc đó chỉ do server tự chạy.
 */
const MAX_BODY_BYTES = 16 * 1024;

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function parseJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let rejected = false;
    request.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(new AppError(ERROR_CODES.INVALID_PAYLOAD, 'Dữ liệu gửi lên quá lớn.', undefined, 413));
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      if (rejected) return;
      if (!body) return resolve({});
      try {
        const parsed = JSON.parse(body);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        resolve(parsed);
      } catch {
        reject(new AppError(ERROR_CODES.INVALID_JSON, 'Dữ liệu JSON không hợp lệ.'));
      }
    });
    request.on('error', reject);
  });
}

function parseMatchId(raw) {
  if (!/^\d{1,9}$/.test(raw)) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, 'Mã trận không hợp lệ.');
  }
  return Number(raw);
}

// Trận với máy không tính điểm xếp hạng: gắn cờ rõ ràng cho client
function toResponse(result) {
  return { success: true, ...result, match: { ...result.match, hasEloRating: false } };
}

function methodNotAllowed(response, allowed) {
  response.setHeader('Allow', allowed);
  sendJson(response, 405, {
    error: `Phương thức không được hỗ trợ. Chỉ chấp nhận ${allowed}.`,
    code: 'METHOD_NOT_ALLOWED',
  });
}

function createPveHandler({
  service = createPveService(),
  authMiddlewareOptions = {},
  userRepository = new PgUserRepository(),
} = {}) {
  return async (request, response) => {
    for (const [headerName, headerValue] of Object.entries(corsHeaders(request))) {
      response.setHeader(headerName, headerValue);
    }
    if (request.method === 'OPTIONS') {
      sendJson(response, 204, {});
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      sendJson(response, 400, { error: 'URL không hợp lệ.' });
      return;
    }

    let user;
    try {
      user = await authenticateRequestWithSession(request, { ...authMiddlewareOptions, userRepository });
    } catch (err) {
      sendError(response, sendJson, err, { defaultStatus: 401 });
      return;
    }

    try {
      if (pathname === '/api/pve/matches') {
        if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
        const body = await parseJsonBody(request);
        const result = await service.startMatch({ userId: user.id, playerColor: body.playerColor });
        sendJson(response, 201, toResponse(result));
        return;
      }

      const matchRoute = pathname.match(/^\/api\/pve\/matches\/([^/]+)(?:\/(moves|legal-moves|resign))?$/);
      if (matchRoute) {
        const matchId = parseMatchId(matchRoute[1]);
        const action = matchRoute[2] || null;

        if (action === null) {
          if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
          const result = await service.getMatch({ userId: user.id, matchId });
          sendJson(response, 200, toResponse(result));
          return;
        }
        if (request.method !== 'POST') return methodNotAllowed(response, 'POST');

        if (action === 'moves') {
          const body = await parseJsonBody(request);
          const result = await service.submitMove({
            userId: user.id,
            matchId,
            move: { from: body.from, to: body.to },
          });
          sendJson(response, 200, toResponse(result));
          return;
        }

        if (action === 'legal-moves') {
          const body = await parseJsonBody(request);
          const result = await service.getLegalMoves({
            userId: user.id,
            matchId,
            from: body.from,
          });
          sendJson(response, 200, { success: true, ...result });
          return;
        }

        const result = await service.resign({ userId: user.id, matchId });
        sendJson(response, 200, toResponse(result));
        return;
      }

      sendJson(response, 404, { error: 'Không tìm thấy đường dẫn.', code: 'NOT_FOUND' });
    } catch (err) {
      sendError(response, sendJson, err, { defaultStatus: 400 });
    }
  };
}

module.exports = { createPveHandler };
