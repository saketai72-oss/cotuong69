/**
 * Luật cờ Tướng cho PvP (Room, trận demo COT-615).
 *
 * CLEAN-01: file này chỉ là ADAPTER. Toàn bộ luật đi quân / chiếu tướng nằm ở một nơi duy nhất
 * là `domain/rules/*` (lưới `board[row][col] = { type: 'K'|'A'|..., color }`, dùng chung với PvE).
 * Ở đây chỉ làm 3 việc:
 *   1. đổi danh sách quân PvP ({ id, color, type: 'general'..., position: 'e3' }) sang lưới;
 *   2. giữ nguyên API cũ (getLegalMoveError / hasLegalMove / isInCheck / parsePosition / positionOf)
 *      và các thông báo lỗi tiếng Việt mà Room / cot615Match đang dùng;
 *   3. giữ vài khác biệt nghiệp vụ của PvP (xem các ghi chú bên dưới).
 *
 * Quy ước: file 'a'..'i' <-> col 0..8, rank 0..9 <-> row 0..9 (Đỏ ở rank 0–4, đi lên).
 */
const { createEmptyBoard } = require('../rules/board');
const {
  getPseudoMoves,
  applyMove,
  isInCheck: isInCheckOnGrid,
} = require('../rules/moveGenerator');
const { findKing, isInPalace } = require('../rules/kingMoves');

const FILES = 'abcdefghi';

// Tên quân PvP -> ký hiệu quân của domain/rules. Loại quân lạ vẫn được đặt lên bàn (làm vật cản)
// nhưng không có nước đi, giống hành vi cũ.
const GRID_TYPE = {
  general: 'K',
  advisor: 'A',
  elephant: 'E',
  horse: 'H',
  chariot: 'R',
  cannon: 'C',
  soldier: 'P',
};
const UNKNOWN_GRID_TYPE = '?';

function parsePosition(position) {
  // SEC-03: chỉ chấp nhận chữ thường ('e3'); toạ độ in hoa trước đây lọt qua rồi gây lỗi
  if (typeof position !== 'string' || !/^[a-i][0-9]$/.test(position)) {
    return null;
  }
  return { file: FILES.indexOf(position[0].toLowerCase()), rank: Number(position[1]) };
}

function positionOf(file, rank) {
  return `${FILES[file]}${rank}`;
}

/**
 * Đổi danh sách quân PvP sang lưới của domain/rules.
 * Quân có `position` sai định dạng bị bỏ qua; hai quân trùng ô thì quân đứng trước thắng
 * (giống `pieces.find` trước đây).
 */
function toGridBoard(pieces) {
  const board = createEmptyBoard();
  for (const piece of pieces) {
    const position = parsePosition(piece.position);
    if (!position || board[position.rank][position.file]) continue;
    board[position.rank][position.file] = {
      type: GRID_TYPE[piece.type] || UNKNOWN_GRID_TYPE,
      color: piece.color,
    };
  }
  return board;
}

/**
 * Tướng bị chiếu (bị quân địch tấn công hoặc hai Tướng đối mặt) theo domain/rules.
 *
 * KHÁC BIỆT CÓ CHỦ ĐÍCH so với domain/rules: bàn cờ thiếu Tướng của `color` thì domain/rules
 * trả false (PvE không bao giờ gặp thế cờ này), còn PvP trả TRUE. Chọn true vì an toàn hơn:
 * thiếu Tướng nghĩa là bên đó đã thua nên mọi nước đi đều bị coi là không hợp lệ và
 * `hasLegalMove` trả false (kết thúc ván), thay vì cho phép đi tiếp một ván không còn Tướng.
 */
function isInCheckOnBoard(board, color) {
  if (!findKing(board, color)) return true;
  return isInCheckOnGrid(board, color);
}

function isInCheck(pieces, color) {
  return isInCheckOnBoard(toGridBoard(pieces), color);
}

function leavesGeneralSafe(board, color, from, to) {
  const next = applyMove(board, {
    from: { row: from.rank, col: from.file },
    to: { row: to.rank, col: to.file },
  }).board;
  return !isInCheckOnBoard(next, color);
}

function hasPieceBetween(board, from, to) {
  // Chỉ dùng cho hai ô cùng cột (Tướng "bay" nhìn nhau)
  const low = Math.min(from.rank, to.rank) + 1;
  const high = Math.max(from.rank, to.rank);
  for (let row = low; row < high; row += 1) {
    if (board[row][from.file]) return true;
  }
  return false;
}

/**
 * Nước đi có đúng cách đi của quân (chưa xét Tướng mình có bị chiếu) hay không.
 * Ngoài nước giả hợp lệ của domain/rules còn nhận 2 trường hợp mà domain/rules đã loại sẵn trong
 * bước sinh nước của Tướng, để giữ đúng thông báo lỗi cũ của PvP:
 *  - Tướng đi 1 bước trong Cung vào ô làm hai Tướng đối mặt -> báo "Tướng bị chiếu" (không phải "sai luật");
 *  - Tướng "bay" ăn Tướng đối phương cùng cột không có quân cản -> báo "Không được bắt Tướng trực tiếp".
 */
function isPseudoLegal(board, piece, from, to) {
  const reachable = getPseudoMoves(board, from.rank, from.file)
    .some((move) => move.row === to.rank && move.col === to.file);
  if (reachable || piece.type !== 'K') return reachable;

  const target = board[to.rank][to.file];
  const isPalaceStep = Math.abs(to.file - from.file) + Math.abs(to.rank - from.rank) === 1 &&
    isInPalace(to.rank, to.file, piece.color);
  if (isPalaceStep) return !target || target.color !== piece.color;

  return target?.type === 'K' && target.color !== piece.color &&
    from.file === to.file && !hasPieceBetween(board, from, to);
}

function getLegalMoveError(pieces, color, fromPosition, toPosition) {
  const from = parsePosition(fromPosition);
  const to = parsePosition(toPosition);
  if (!from || !to) return 'Tọa độ ô cờ không hợp lệ.';

  const board = toGridBoard(pieces);
  const piece = board[from.rank][from.file];
  if (!piece) return 'Ô nguồn không có quân cờ.';
  if (piece.color !== color) return 'Bạn chỉ được đi quân thuộc phe của mình.';
  const target = board[to.rank][to.file];
  if (target?.color === color) return 'Ô đích đang có quân cùng phe.';
  if (!isPseudoLegal(board, piece, from, to)) return 'Nước đi không đúng luật của quân cờ.';

  // Luật PvP: không bao giờ được "ăn" Tướng, kể cả khi thế cờ đã sai (khác PvE chỉ lọc theo chiếu)
  if (target?.type === 'K') return 'Không được bắt Tướng trực tiếp.';
  if (!leavesGeneralSafe(board, color, from, to)) return 'Nước đi khiến Tướng phe bạn bị chiếu.';
  return null;
}

function getLegalMoveDestinations(pieces, color, fromPosition) {
  const from = parsePosition(fromPosition);
  if (!from || (color !== 'red' && color !== 'black')) return [];

  const board = toGridBoard(pieces);
  const piece = board[from.rank][from.file];
  if (!piece || piece.color !== color) return [];

  return getPseudoMoves(board, from.rank, from.file)
    .filter((move) => {
      if (board[move.row][move.col]?.type === 'K') return false;
      return leavesGeneralSafe(board, color, from, { file: move.col, rank: move.row });
    })
    .map((move) => positionOf(move.col, move.row));
}

function hasLegalMove(pieces, color) {
  const board = toGridBoard(pieces);
  for (let row = 0; row < board.length; row += 1) {
    for (let col = 0; col < board[row].length; col += 1) {
      const piece = board[row][col];
      if (!piece || piece.color !== color) continue;
      const from = { file: col, rank: row };
      for (const move of getPseudoMoves(board, row, col)) {
        if (board[move.row][move.col]?.type === 'K') continue;
        if (leavesGeneralSafe(board, color, from, { file: move.col, rank: move.row })) return true;
      }
    }
  }
  return false;
}

module.exports = {
  getLegalMoveError,
  getLegalMoveDestinations,
  hasLegalMove,
  isInCheck,
  parsePosition,
  positionOf,
};
