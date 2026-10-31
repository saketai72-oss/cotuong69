// PVE-UI: máy chủ PvE giả cho test Vitest — mô phỏng HỢP ĐỒNG của backend (xem
// backend/src/presentation/http/routes/pve.routes.js và application/use-cases/game/pve/pveService.js)
// qua giao diện `fetch`. Có thế cờ khai cuộc thật, máy đáp bằng một nước tốt đơn giản,
// đồng hồ lượt 60 giây và tự xử thua khi hết giờ (giống backend: kết quả chỉ lộ ra khi GET / đi quân).
const BACK_RANK = ['R', 'H', 'E', 'A', 'K', 'A', 'E', 'H', 'R'];

export function initialBoard() {
  const board = Array.from({ length: 10 }, () => Array(9).fill(null));
  const rows = { red: { back: 0, cannon: 2, pawn: 3 }, black: { back: 9, cannon: 7, pawn: 6 } };
  for (const color of ['red', 'black']) {
    BACK_RANK.forEach((type, col) => { board[rows[color].back][col] = { type, color }; });
    for (const col of [1, 7]) board[rows[color].cannon][col] = { type: 'C', color };
    for (const col of [0, 2, 4, 6, 8]) board[rows[color].pawn][col] = { type: 'P', color };
  }
  return board;
}

export function createFakePveServer({ playerColor = 'red', requireToken = true, turnLimitMs = 60000 } = {}) {
  const state = {
    id: 1,
    playerColor,
    botColor: playerColor === 'red' ? 'black' : 'red',
    sideToMove: 'red',
    status: 'PLAYING',
    result: null,
    endReason: null,
    ply: 0,
    board: initialBoard(),
    turnStartedAt: Date.now(),
  };
  const requests = [];
  let moveFailure = null; // { status, code, error } cho nước đi kế tiếp

  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fail = (status, code, error) => json(status, { error, code });

  function view() {
    const playerClockRunning = state.status === 'PLAYING' && state.sideToMove === state.playerColor;
    return {
      id: state.id,
      playerColor: state.playerColor,
      botColor: state.botColor,
      sideToMove: state.sideToMove,
      status: state.status,
      result: state.result,
      endReason: state.endReason,
      ply: state.ply,
      board: JSON.parse(JSON.stringify(state.board)),
      turnLimitMs,
      remainingMs: playerClockRunning ? Math.max(0, turnLimitMs - (Date.now() - state.turnStartedAt)) : null,
      hasEloRating: false,
    };
  }

  function finish(result, endReason) {
    state.status = 'FINISHED';
    state.result = result;
    state.endReason = endReason;
  }

  // máy chủ tự xử thua khi người chơi để quá hạn lượt (xảy ra khi GET / đi quân, như backend)
  function checkTimeout() {
    if (
      state.status === 'PLAYING' && state.sideToMove === state.playerColor &&
      Date.now() - state.turnStartedAt >= turnLimitMs
    ) {
      finish('LOSS', 'TIMEOUT');
    }
  }

  function botReply() {
    const forward = state.botColor === 'red' ? 1 : -1;
    for (let row = 0; row < 10; row += 1) {
      for (let col = 0; col < 9; col += 1) {
        const cell = state.board[row][col];
        if (cell && cell.color === state.botColor && cell.type === 'P' && !state.board[row + forward]?.[col]
          && row + forward >= 0 && row + forward <= 9) {
          state.board[row + forward][col] = cell;
          state.board[row][col] = null;
          state.ply += 1;
          state.sideToMove = state.playerColor;
          state.turnStartedAt = Date.now();
          return { ply: state.ply, side: state.botColor, actor: 'BOT', from: { row, col }, to: { row: row + forward, col } };
        }
      }
    }
    return null;
  }

  // Người chơi cầm Đen: máy (Đỏ) đi nước đầu ngay khi tạo trận
  if (playerColor === 'black') botReply();

  async function fakeFetch(url, init = {}) {
    const method = init.method || 'GET';
    const headers = init.headers || {};
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url: String(url), method, headers, body });
    await Promise.resolve();

    if (requireToken && !headers.Authorization) return fail(401, 'NO_TOKEN', 'Thiếu token');
    const route = String(url).replace(/^.*\/api\/pve/, '').match(/^\/matches\/(\d+)(?:\/(moves|legal-moves|resign))?$/);
    if (!route) return fail(404, 'NOT_FOUND', 'Không tìm thấy đường dẫn.');
    if (Number(route[1]) !== state.id) return fail(404, 'MATCH_NOT_FOUND', 'Không tìm thấy trận đấu');
    const action = route[2] || null;

    if (action === null && method === 'GET') {
      checkTimeout();
      return json(200, { success: true, match: view() });
    }

    if (action === 'legal-moves' && method === 'POST') {
      checkTimeout();
      const { from } = body || {};
      if (state.status !== 'PLAYING' || state.sideToMove !== state.playerColor) {
        return json(200, { success: true, destinations: [] });
      }
      if (from === 'a3' && state.board[3][0]?.color === state.playerColor) {
        return json(200, { success: true, destinations: ['a4'] });
      }
      return json(200, { success: true, destinations: [] });
    }

    if (action === 'moves' && method === 'POST') {
      if (moveFailure) {
        const failure = moveFailure;
        moveFailure = null;
        return fail(failure.status, failure.code, failure.error);
      }
      checkTimeout();
      if (state.status !== 'PLAYING') return fail(409, 'MATCH_FINISHED', 'Trận đấu đã kết thúc');
      if (state.sideToMove !== state.playerColor) return fail(409, 'NOT_YOUR_TURN', 'Chưa tới lượt của bạn');
      const { from, to } = body || {};
      const piece = from && state.board[from.row] && state.board[from.row][from.col];
      if (!piece || piece.color !== state.playerColor) {
        return fail(400, 'ILLEGAL_MOVE', 'Nước đi không hợp lệ: ô xuất phát không có quân của bạn');
      }
      const target = state.board[to.row] && state.board[to.row][to.col];
      if (target && target.color === state.playerColor) {
        return fail(400, 'ILLEGAL_MOVE', 'Nước đi không hợp lệ: không được ăn quân của mình');
      }
      state.board[to.row][to.col] = piece;
      state.board[from.row][from.col] = null;
      state.ply += 1;
      state.sideToMove = state.botColor;
      const playerMove = { ply: state.ply, side: state.playerColor, actor: 'PLAYER', from, to };
      const bot = botReply();
      return json(200, { success: true, match: view(), playerMove, botMove: bot });
    }

    if (action === 'resign' && method === 'POST') {
      if (state.status !== 'PLAYING') return fail(409, 'MATCH_FINISHED', 'Trận đấu đã kết thúc');
      finish('LOSS', 'RESIGN');
      return json(200, { success: true, match: view() });
    }

    return fail(405, 'METHOD_NOT_ALLOWED', 'Phương thức không được hỗ trợ.');
  }

  return {
    state,
    requests,
    fetch: fakeFetch,
    failNextMove(failure) { moveFailure = failure; },
    /** Máy chủ tự kết thúc ván (chiếu bí, hoà...) — client chỉ biết qua GET. */
    finish,
  };
}
