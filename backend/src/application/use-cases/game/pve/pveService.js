/**
 * FE-10: lớp điều phối PvE cho tầng HTTP và sweeper.
 *
 * Các use-case `playBotTurn` / `checkPveTimeout` KHÔNG được mở ra thành endpoint — client không
 * được phép "ra lệnh" cho máy đi hay xử hết giờ. Lớp này là nơi duy nhất gọi chúng:
 *   - startMatch      : giới hạn số trận PLAYING / người chơi, tạo trận, máy đi trước nếu người chơi cầm Đen
 *   - submitMove      : lưu nước người chơi rồi CHO MÁY ĐI NGAY, trả về cả hai nước
 *   - resign          : xin thua
 *   - getMatch        : đọc trận (kiểm quyền sở hữu) sau khi "đẩy" trận tới trạng thái mới nhất
 *   - advanceMatch    : dùng cho sweeper — tới lượt máy thì cho máy đi, ngược lại kiểm tra hết giờ
 */
const { PgPveMatchRepository } = require('../../../../infrastructure/database/repositories/PgPveMatchRepository');
const { PVE_MATCH_STATUS, PLAYER_TURN_LIMIT_MS } = require('../../../../domain/entities/PveMatch');
const { getLegalMovesForPiece } = require('../../../../domain/rules/moveGenerator');
const { AppError, ERROR_CODES } = require('../../../../core/errors/AppError');
const { createPveUseCases } = require('./index');
const { loadOwnedMatch } = require('./loadOwnedMatch');

// Số trận PvE đang chơi (PLAYING) tối đa cho mỗi người. Trận bỏ dở tự kết thúc sau 60 giây
// không đi (COT-636) nên số này chỉ chặn việc mở hàng loạt trận cùng lúc.
const MAX_ACTIVE_PVE_MATCHES_PER_USER = Number(process.env.MAX_ACTIVE_PVE_MATCHES_PER_USER || 3);

/**
 * Dạng trận trả về cho client: thêm thông tin đồng hồ lượt (cờ báo xếp hạng do tầng HTTP gắn).
 */
function serializeMatch(match, nowMs) {
  const playerClockRunning =
    match.status === PVE_MATCH_STATUS.PLAYING && match.sideToMove === match.playerColor;
  const remainingMs = playerClockRunning
    ? Math.max(0, PLAYER_TURN_LIMIT_MS - (nowMs - match.turnStartedAt.getTime()))
    : null;
  return {
    id: match.id,
    playerColor: match.playerColor,
    botColor: match.botColor,
    sideToMove: match.sideToMove,
    status: match.status,
    result: match.result,
    endReason: match.endReason,
    ply: match.ply,
    board: match.board,
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
    finishedAt: match.finishedAt,
    turnStartedAt: match.turnStartedAt,
    turnLimitMs: PLAYER_TURN_LIMIT_MS,
    remainingMs,
  };
}

/**
 * @param {{ pveMatchRepository?: object, clock?: () => Date, random?: () => number,
 *           maxActiveMatches?: number, useCases?: object }} [deps]
 */
function createPveService({
  pveMatchRepository = new PgPveMatchRepository(),
  clock = () => new Date(),
  random = Math.random,
  maxActiveMatches = MAX_ACTIVE_PVE_MATCHES_PER_USER,
  useCases = createPveUseCases({ pveMatchRepository, clock, random }),
} = {}) {
  const view = (match) => serializeMatch(match, clock().getTime());

  // Chuỗi hoá tạo trận theo từng người: "đếm trận PLAYING" rồi "tạo" là hai bước bất đồng bộ,
  // không khoá thì hai request đồng thời cùng thấy còn chỗ và vượt giới hạn.
  const userLocks = new Map();
  async function withUserLock(userId, work) {
    const key = String(userId);
    const previous = userLocks.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    const tail = run.catch(() => {});
    userLocks.set(key, tail);
    try {
      return await run;
    } finally {
      if (userLocks.get(key) === tail) userLocks.delete(key);
    }
  }

  /** Cho máy đi nếu đang tới lượt máy; lỗi bất ngờ chỉ ghi log để sweeper thử lại sau. */
  async function botReplyIfDue(match) {
    if (match.status !== PVE_MATCH_STATUS.PLAYING || match.sideToMove !== match.botColor) {
      return { match, botMove: null };
    }
    try {
      const outcome = await useCases.playBotTurn(match.id, { expectedPly: match.ply });
      if (outcome.played) return { match: outcome.match, botMove: outcome.move };
      return { match: outcome.match || match, botMove: null };
    } catch (err) {
      console.error('[PvE] Máy không đi được, sweeper sẽ thử lại:', err && err.message);
      return { match, botMove: null };
    }
  }

  /**
   * Đẩy một trận PLAYING tới trạng thái mới nhất: tới lượt máy -> máy đi; ngược lại -> xét hết giờ.
   * Idempotent và an toàn khi chạy đồng thời với request của người chơi (saveMove/finish có điều kiện).
   * @returns {Promise<object>} trận mới nhất
   */
  async function advanceMatch(matchId) {
    const match = await pveMatchRepository.findById(matchId);
    if (!match) {
      throw new AppError(ERROR_CODES.MATCH_NOT_FOUND, 'Không tìm thấy trận đấu', { matchId });
    }
    if (match.status !== PVE_MATCH_STATUS.PLAYING) return match;
    if (match.sideToMove === match.botColor) {
      const outcome = await useCases.playBotTurn(matchId);
      return outcome.match || match;
    }
    const { match: current } = await useCases.checkPveTimeout(matchId);
    return current;
  }

  return {
    maxActiveMatches,
    useCases,
    view,

    async startMatch({ userId, playerColor }) {
      return withUserLock(userId, async () => {
        const active = await pveMatchRepository.countPlayingByUser(userId);
        if (active >= maxActiveMatches) {
          throw new AppError(
            ERROR_CODES.TOO_MANY_PVE_MATCHES,
            `Bạn đang có ${active} ván với máy chưa kết thúc (tối đa ${maxActiveMatches}). Hãy hoàn tất hoặc xin thua bớt rồi tạo ván mới.`,
            { active, max: maxActiveMatches }
          );
        }
        const created = await useCases.createPveMatch({ userId, playerColor });
        // Người chơi cầm Đen -> máy (Đỏ) đi trước
        const { match, botMove } = await botReplyIfDue(created);
        return { match: view(match), botMove };
      });
    },

    async submitMove({ userId, matchId, move }) {
      const playerOutcome = await useCases.submitPlayerMove(matchId, userId, move);
      const { match, botMove } = await botReplyIfDue(playerOutcome.match);
      return {
        match: view(match),
        playerMove: playerOutcome.move,
        botMove,
        gameStatus: playerOutcome.gameStatus,
      };
    },

    async resign({ userId, matchId }) {
      const match = await useCases.resignPveMatch(matchId, userId);
      return { match: view(match) };
    },

    async getMatch({ userId, matchId }) {
      // Kiểm quyền TRƯỚC khi tác động lên trận (không để người lạ kích hoạt máy đi / xử hết giờ)
      await loadOwnedMatch(pveMatchRepository, matchId, userId);
      const advanced = await advanceMatch(matchId);
      return { match: view(advanced) };
    },

    async getLegalMoves({ userId, matchId, from }) {
      await loadOwnedMatch(pveMatchRepository, matchId, userId);
      const match = await advanceMatch(matchId);
      if (
        match.status !== PVE_MATCH_STATUS.PLAYING ||
        match.sideToMove !== match.playerColor ||
        typeof from !== 'string' ||
        !/^[a-i][0-9]$/.test(from)
      ) {
        return { destinations: [] };
      }

      const col = from.charCodeAt(0) - 97;
      const row = Number(from[1]);
      if (match.board[row]?.[col]?.color !== match.playerColor) {
        return { destinations: [] };
      }
      const destinations = getLegalMovesForPiece(match.board, row, col)
        .map(({ row: destinationRow, col: destinationCol }) =>
          `${String.fromCharCode(97 + destinationCol)}${destinationRow}`);
      return { destinations };
    },

    advanceMatch,

    /** Danh sách trận đang PLAYING cho sweeper. */
    listPlaying(options) {
      return pveMatchRepository.listPlaying(options);
    },
  };
}

module.exports = { createPveService, serializeMatch, MAX_ACTIVE_PVE_MATCHES_PER_USER };
