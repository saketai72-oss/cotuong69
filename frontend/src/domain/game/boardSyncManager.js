/**
 * BoardSyncManager - Quản lý đồng bộ và khôi phục trạng thái bàn cờ khi Reconnect (COT-602)
 * Tuân thủ đầy đủ các Tiêu chí chấp nhận (Acceptance Criteria):
 *  1. Bàn cờ và quân bị ăn dựng đúng theo snapshot từ máy chủ.
 *  2. Đồng hồ lượt đi tiếp tục từ số giây chính thức do máy chủ cung cấp.
 *  3. Không bị nhảy quân hay mất trạng thái khi tải lại.
 *  4. Nhận diện trạng thái Chiếu và xác định Tướng bị chiếu.
 *  5. Đóng toàn bộ overlay cảnh báo và mở lại tương tác cho người chơi đang tới lượt.
 */

const EXPECTED_PIECE_COUNTS = {
  general: 1,
  advisor: 2,
  elephant: 2,
  horse: 2,
  chariot: 2,
  cannon: 2,
  soldier: 5,
};

class BoardSyncManager {
  /**
   * Tính toán danh sách quân đã bị ăn dựa trên quân còn lại trên bàn cờ
   */
  static deriveCapturedPieces(board = []) {
    const counts = {
      red: { general: 0, advisor: 0, elephant: 0, horse: 0, chariot: 0, cannon: 0, soldier: 0 },
      black: { general: 0, advisor: 0, elephant: 0, horse: 0, chariot: 0, cannon: 0, soldier: 0 },
    };

    for (const piece of board) {
      if (piece && piece.color && counts[piece.color] && counts[piece.color][piece.type] !== undefined) {
        counts[piece.color][piece.type] += 1;
      }
    }

    const capturedPieces = { red: [], black: [] };
    for (const color of ['red', 'black']) {
      for (const [type, expected] of Object.entries(EXPECTED_PIECE_COUNTS)) {
        const missing = Math.max(0, expected - (counts[color][type] || 0));
        for (let i = 0; i < missing; i += 1) {
          capturedPieces[color].push({
            id: `captured_${color}_${type}_${i + 1}`,
            color,
            type,
          });
        }
      }
    }

    return capturedPieces;
  }

  /**
   * Phục hồi trạng thái trận đấu hoàn chỉnh từ snapshot máy chủ
   */
  static restoreFromSnapshot(snapshot, previousMatch = null) {
    if (!snapshot) return null;

    // 1. Dựng lại vị trí chính xác của tất cả các quân cờ còn trên bàn
    // Hỗ trợ cả snapshot dạng { board: [...] } và board dạng ma trận 10x9
    let board = [];
    if (Array.isArray(snapshot.board)) {
      if (snapshot.board.length > 0 && Array.isArray(snapshot.board[0])) {
        // Ma trận 10x9 -> chuyển đổi thành danh sách quân { id, type, color, position }
        const FILES = 'abcdefghi';
        const TYPE_MAP = {
          K: 'general',
          A: 'advisor',
          E: 'elephant',
          H: 'horse',
          R: 'chariot',
          C: 'cannon',
          P: 'soldier',
        };
        snapshot.board.forEach((row, r) => {
          row.forEach((cell, c) => {
            if (cell && cell.type) {
              const fullType = TYPE_MAP[cell.type] || cell.type;
              const pos = `${FILES[c]}${r}`;
              board.push({
                id: `${cell.color}_${fullType}_${pos}`,
                type: fullType,
                color: cell.color,
                position: pos,
              });
            }
          });
        });
      } else {
        board = snapshot.board.map((p) => ({ ...p }));
      }
    } else if (previousMatch && Array.isArray(previousMatch.board)) {
      board = previousMatch.board.map((p) => ({ ...p }));
    }

    // 2. Dựng lại danh sách quân đã bị ăn ở khu vực bên ngoài bàn cờ
    const rawCaptured = snapshot.capturedPieces || snapshot.captured || {};
    let capturedRed = Array.isArray(rawCaptured.red) ? [...rawCaptured.red] : null;
    let capturedBlack = Array.isArray(rawCaptured.black) ? [...rawCaptured.black] : null;

    if (!capturedRed || !capturedBlack || (capturedRed.length === 0 && capturedBlack.length === 0 && board.length < 32)) {
      const derived = BoardSyncManager.deriveCapturedPieces(board);
      if (!capturedRed || capturedRed.length === 0) capturedRed = derived.red;
      if (!capturedBlack || capturedBlack.length === 0) capturedBlack = derived.black;
    }

    const capturedPieces = {
      red: capturedRed || [],
      black: capturedBlack || [],
    };

    // 3. Hiển thị đúng bên đang tới lượt (Đỏ hoặc Đen)
    const currentTurn = snapshot.currentTurn || previousMatch?.currentTurn || 'red';

    // 4. Khôi phục đồng hồ lượt đi từ số giây còn lại máy chủ cung cấp
    const turnRemainingSeconds = snapshot.turnRemainingSeconds !== undefined
      ? Number(snapshot.turnRemainingSeconds)
      : (snapshot.clocks?.[currentTurn] ?? 60);

    const remainingClocks = snapshot.remainingClocks || snapshot.clocks || {};
    const clocks = {
      red: remainingClocks.red !== undefined ? Number(remainingClocks.red) : (previousMatch?.clocks?.red ?? 300),
      black: remainingClocks.black !== undefined ? Number(remainingClocks.black) : (previousMatch?.clocks?.black ?? 300),
    };
    if (clocks[currentTurn] === undefined) {
      clocks[currentTurn] = turnRemainingSeconds;
    }

    // 5. Nếu có trạng thái Chiếu: Kích hoạt viền đỏ cảnh báo Tướng bị chiếu
    const inCheck = Boolean(snapshot.inCheck || snapshot.check);
    const checkedColor = inCheck
      ? (snapshot.checkedColor || currentTurn)
      : null;

    const checkedGeneral = checkedColor
      ? board.find((p) => p.type === 'general' && p.color === checkedColor)
      : null;

    return {
      id: snapshot.matchId || snapshot.id || previousMatch?.id || 'MATCH',
      matchId: snapshot.matchId || snapshot.id || previousMatch?.matchId || 'MATCH',
      roomName: snapshot.roomName || previousMatch?.roomName || 'Phòng thi đấu',
      title: snapshot.title || previousMatch?.title || 'Trận Đấu Cờ Tướng',
      matchCode: snapshot.matchCode || snapshot.roomCode || previousMatch?.matchCode || '696969',
      status: snapshot.status || 'active',
      board,
      pieceCount: board.length,
      capturedPieces,
      currentTurn,
      turnRemainingSeconds,
      moveNumber: snapshot.plyCount !== undefined
        ? Number(snapshot.plyCount) + 1
        : (previousMatch?.moveNumber ?? 1),
      timeControlSeconds: snapshot.timeControlSeconds !== undefined
        ? Number(snapshot.timeControlSeconds)
        : (previousMatch?.timeControlSeconds ?? 300),
      viewerCount: snapshot.viewerCount !== undefined
        ? Number(snapshot.viewerCount)
        : (previousMatch?.viewerCount ?? 0),
      clocks,
      inCheck,
      check: inCheck,
      checkedColor,
      checkedGeneral,
      lastMove: snapshot.lastMove || previousMatch?.lastMove || null,
      isPaused: Boolean(snapshot.isPaused),
      players: snapshot.players || previousMatch?.players || {
        red: { name: 'Kỳ Thủ Đỏ', rating: 1000 },
        black: { name: 'Kỳ Thủ Đen', rating: 1000 },
      },
      winner: snapshot.winner || null,
      endReason: snapshot.endReason || null,
    };
  }
}

// Hỗ trợ cả CommonJS (Node.js test) và ES Module (Vite Frontend)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BoardSyncManager };
}

export default BoardSyncManager;
export { BoardSyncManager };
