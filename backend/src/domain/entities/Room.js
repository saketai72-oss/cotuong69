// BE-20: giới hạn số nước đi của một ván -> quá thì xử hoà (tránh ván vô hạn).
const { MAX_PLY_PER_MATCH: MAX_PLY } = require('../rules/matchLimits');

const { createInitialBoard } = require('../rules/board');
const { createInitialArmy } = require('./cot615Match');

class Room {
  constructor({
    code,
    name,
    hostId,
    hostUser,
    isPrivate = false,
    maxSpectators = 10,
    status = 'WAITING_OPPONENT',
    createdAt = new Date(),
  }) {
    this.code = code.toString().toUpperCase();
    this.name = name || `Phòng cờ #${this.code}`;
    this.hostId = Number(hostId);
    this.isPrivate = Boolean(isPrivate);
    this.maxSpectators = Number(maxSpectators);
    this.status = status; // WAITING_OPPONENT, FULL_PLAYERS, PLAYING, FINISHED, CLOSED
    this.createdAt = createdAt;
    // BE-08: mốc hoạt động cuối để sweeper dọn phòng bỏ hoang
    this.lastActivityAt = new Date();

    // Người chơi: Red (Host mặc định là Red) và Black
    this.players = {
      red: hostUser ? { id: Number(hostUser.id), username: hostUser.username, displayName: hostUser.displayName, eloRating: hostUser.eloRating, avatarUrl: hostUser.avatarUrl } : null,
      black: null,
    };

    // Khán giả: tối đa 10 người
    this.spectators = [];

    // Trạng thái sẵn sàng và thành viên bị kick (COT-592)
    this.readyStates = new Set();
    this.kickedUsers = new Set();
    this.matchId = null;

    // Trạng thái ván đấu & Reconnect (COT-593, COT-594, COT-595)
    this.matchState = null;
    this.reconnectState = null;

    // Trạng thái Video Call WebRTC (COT-624, COT-626)
    this.videoCall = null;
  }

  getDeepLink(baseUrl = '') {
    return `${baseUrl}/room/${this.code}`;
  }

  getParticipantRole(userId) {
    const uid = Number(userId);
    if (this.players.red && this.players.red.id === uid) {
      return { role: 'PLAYER', side: 'RED' };
    }
    if (this.players.black && this.players.black.id === uid) {
      return { role: 'PLAYER', side: 'BLACK' };
    }
    const isSpectator = this.spectators.some((s) => s.id === uid);
    if (isSpectator) {
      return { role: 'SPECTATOR', side: null };
    }
    return null;
  }

  canMove(userId) {
    const roleInfo = this.getParticipantRole(userId);
    return roleInfo !== null && roleInfo.role === 'PLAYER';
  }

  touch() {
    this.lastActivityAt = new Date();
  }

  addParticipant(user) {
    if (!user || !user.id) {
      const err = new Error('Thông tin người dùng không hợp lệ.');
      err.code = 'INVALID_USER';
      err.statusCode = 400;
      throw err;
    }

    const uid = Number(user.id);
    this.touch();
    if (this.kickedUsers.has(uid)) {
      const err = new Error('Bạn đã bị chủ phòng loại khỏi phòng này.');
      err.code = 'USER_KICKED';
      err.statusCode = 403;
      throw err;
    }

    const existingRole = this.getParticipantRole(uid);
    if (existingRole) {
      return {
        ...existingRole,
        isNew: false,
        room: this.getSummary(),
      };
    }

    if (this.status === 'CLOSED' || this.status === 'FINISHED') {
      const err = new Error('Phòng cờ đã kết thúc hoặc bị đóng.');
      err.code = 'ROOM_CLOSED';
      err.statusCode = 410;
      throw err;
    }

    const userData = {
      id: uid,
      username: user.username,
      displayName: user.displayName || user.username,
      eloRating: user.eloRating ?? 1000,
      avatarUrl: user.avatarUrl || null,
    };

    // 1. Phân vai trò người chơi nếu còn chỗ trống (ưu tiên RED rồi đến BLACK)
    if (!this.players.red) {
      this.players.red = userData;
      return {
        role: 'PLAYER',
        side: 'RED',
        isNew: true,
        room: this.getSummary(),
      };
    }

    if (!this.players.black) {
      this.players.black = userData;
      // Khi đã đủ 2 người, chuyển trạng thái sẵn sàng
      return {
        role: 'PLAYER',
        side: 'BLACK',
        isNew: true,
        room: this.getSummary(),
      };
    }

    // 2. Nếu đã đủ 2 người chơi -> Gán vai trò Khán giả (Spectator)
    if (this.spectators.length >= this.maxSpectators) {
      const err = new Error(`Phòng cờ đã đạt giới hạn tối đa ${this.maxSpectators} khán giả.`);
      err.code = 'ROOM_FULL';
      err.statusCode = 409;
      throw err;
    }

    this.spectators.push({
      ...userData,
      joinedAt: new Date(),
    });

    return {
      role: 'SPECTATOR',
      side: null,
      isNew: true,
      room: this.getSummary(),
    };
  }

  removeParticipant(userId) {
    const uid = Number(userId);
    // REV-17: người rời đi không được để lại trạng thái "sẵn sàng"
    this.readyStates.delete(uid);
    if (this.players.red && this.players.red.id === uid) {
      this.players.red = null;
    } else if (this.players.black && this.players.black.id === uid) {
      this.players.black = null;
    } else {
      this.spectators = this.spectators.filter((s) => s.id !== uid);
    }
  }

  getSummary(baseUrl = '') {
    return {
      code: this.code,
      name: this.name,
      hostId: this.hostId,
      status: this.status,
      isPrivate: this.isPrivate,
      deepLink: this.getDeepLink(baseUrl),
      players: {
        red: this.players.red,
        black: this.players.black,
      },
      playerCount: (this.players.red ? 1 : 0) + (this.players.black ? 1 : 0),
      spectatorCount: this.spectators.length,
      maxSpectators: this.maxSpectators,
      spectators: this.spectators.map((s) => ({
        id: s.id,
        username: s.username,
        displayName: s.displayName,
      })),
      ready: {
        red: this.players.red ? this.readyStates.has(this.players.red.id) : false,
        black: this.players.black ? this.readyStates.has(this.players.black.id) : false,
      },
      readyStates: Array.from(this.readyStates),
      matchId: this.matchId,
      matchState: this.matchState ? {
        matchId: this.matchState.matchId,
        currentTurn: this.matchState.currentTurn,
        turnRemainingSeconds: this.getRemainingTurnSeconds(),
        turnDurationSeconds: this.matchState.turnDurationSeconds,
        timeControlSeconds: this.matchState.timeControlSeconds,
        plyCount: this.matchState.plyCount,
        viewerCount: this.spectators.length,
        remainingClocks: { ...this.matchState.remainingClocks },
        isPaused: Boolean(this.matchState.isPaused),
        inCheck: Boolean(this.matchState.inCheck),
        checkedColor: this.matchState.checkedColor,
      } : null,
      reconnectState: this.reconnectState ? {
        disconnectedUserId: this.reconnectState.disconnectedUserId,
        disconnectedSide: this.reconnectState.disconnectedSide,
        countdownSeconds: this.reconnectState.countdownSeconds,
        isPaused: true,
      } : null,
      createdAt: this.createdAt,
    };
  }

  setReady(userId, isReady = true) {
    const uid = Number(userId);
    const roleInfo = this.getParticipantRole(uid);
    if (!roleInfo || roleInfo.role !== 'PLAYER') {
      const err = new Error('Khán giả chỉ có quyền xem, không thể đặt trạng thái sẵn sàng.');
      err.code = 'FORBIDDEN';
      err.statusCode = 403;
      throw err;
    }

    if (isReady) {
      this.readyStates.add(uid);
    } else {
      this.readyStates.delete(uid);
    }

    return {
      userId: uid,
      isReady: this.readyStates.has(uid),
      allReady: this.canStartGame(),
    };
  }

  isReady(userId) {
    return this.readyStates.has(Number(userId));
  }

  canStartGame() {
    if (!this.players.red || !this.players.black) return false;
    if (this.status === 'PLAYING' || this.status === 'CLOSED') return false;
    return this.readyStates.has(this.players.red.id) && this.readyStates.has(this.players.black.id);
  }

  getRemainingTurnSeconds() {
    if (!this.matchState) return 0;
    if (this.matchState.isPaused) return this.matchState.turnRemainingSeconds;
    // REV-11: sau một lần tạm dừng, phần còn lại của lượt được lưu chính xác ở turnRemainingMs
    if (this.matchState.turnRemainingMs != null) return Math.ceil(this.getTurnRemainingMs() / 1000);
    const elapsed = Math.max(0, Math.floor((Date.now() - this.matchState.turnStartedAt) / 1000));
    return Math.max(0, this.matchState.turnRemainingSeconds - elapsed);
  }

  /**
   * REV-11: thời gian còn lại của LƯỢT hiện tại, tính bằng mili-giây (chính xác, không làm tròn).
   */
  getTurnRemainingMs() {
    if (!this.matchState) return 0;
    const baseMs = this.matchState.turnRemainingMs != null
      ? Number(this.matchState.turnRemainingMs)
      : Number(this.matchState.turnRemainingSeconds) * 1000;
    if (this.matchState.isPaused) return Math.max(0, baseMs);
    return Math.max(0, baseMs - (Date.now() - this.matchState.turnStartedAt));
  }

  /**
   * REV-11: đồng hồ TỔNG còn lại (mili-giây) của bên đang tới lượt, đã trừ phần thời gian
   * đã trôi từ turnStartedAt (remainingClocks chỉ được trừ tại nước đi / lúc tạm dừng).
   * @returns {number} Infinity nếu không có dữ liệu đồng hồ
   */
  getClockRemainingMs(color = this.matchState && this.matchState.currentTurn) {
    if (!this.matchState || !this.matchState.remainingClocks) return Infinity;
    const clock = Number(this.matchState.remainingClocks[color]);
    if (!Number.isFinite(clock)) return Infinity;
    const running = this.matchState.isPaused ? 0 : Date.now() - this.matchState.turnStartedAt;
    return Math.max(0, clock * 1000 - running);
  }

  pauseMatchForDisconnect(userId, countdownSeconds = 60) {
    if (this.status !== 'PLAYING' || !this.matchState) return null;
    const uid = Number(userId);
    const roleInfo = this.getParticipantRole(uid);
    if (!roleInfo || roleInfo.role !== 'PLAYER') return null;

    // REV-11: lần tạm dừng đầu tiên -> trừ NGAY thời gian bên đang tới lượt đã dùng vào đồng
    // hồ tổng và lưu phần còn lại của lượt (chính xác tới mili-giây). Khi resume chỉ đặt lại
    // turnStartedAt, KHÔNG reset lượt về đầy 60s. Nếu đã tạm dừng sẵn (người thứ hai rớt
    // mạng) thì không trừ lần nữa.
    if (!this.matchState.isPaused) {
      const elapsedMs = Math.max(0, Date.now() - this.matchState.turnStartedAt);
      const turnColor = this.matchState.currentTurn;
      const clocks = this.matchState.remainingClocks;
      if (clocks && Number.isFinite(Number(clocks[turnColor]))) {
        clocks[turnColor] = Math.max(0, Number(clocks[turnColor]) - elapsedMs / 1000);
      }
      const remainingMs = Math.max(0, this.getTurnRemainingMs());
      this.matchState.turnRemainingMs = remainingMs;
      this.matchState.turnRemainingSeconds = Math.ceil(remainingMs / 1000);
    }
    const remaining = this.getRemainingTurnSeconds();
    this.matchState.isPaused = true;

    // BE-06: lưu trạng thái mất kết nối THEO TỪNG BÊN (trước đây chỉ 1 state nên
    // người thứ hai rớt mạng ghi đè người thứ nhất -> không còn timer, ván treo)
    const sideKey = String(roleInfo.side || '').toLowerCase();
    if (!this.reconnectState || !this.reconnectState.bySide) {
      const previous = this.reconnectState;
      this.reconnectState = { bySide: { red: null, black: null } };
      if (previous && previous.disconnectedSide) {
        const previousKey = String(previous.disconnectedSide).toLowerCase();
        if (previousKey === 'red' || previousKey === 'black') {
          this.reconnectState.bySide[previousKey] = previous;
        }
      }
    }

    const sideState = {
      disconnectedUserId: uid,
      disconnectedSide: roleInfo.side,
      countdownSeconds: Number(countdownSeconds),
      pausedAt: Date.now(),
    };
    if (sideKey === 'red' || sideKey === 'black') {
      this.reconnectState.bySide[sideKey] = sideState;
    }

    // Giữ các field phẳng để tương thích client/đoạn code cũ
    this.reconnectState.disconnectedUserId = uid;
    this.reconnectState.disconnectedSide = roleInfo.side;
    this.reconnectState.countdownSeconds = Number(countdownSeconds);
    this.reconnectState.pausedAt = sideState.pausedAt;

    return {
      room: this.getSummary(),
      reconnectState: this.reconnectState,
      turnRemainingSeconds: remaining,
    };
  }

  /** BE-06: các bên đang mất kết nối (mảng tên bên: 'red' | 'black') */
  getDisconnectedSides() {
    const bySide = this.reconnectState && this.reconnectState.bySide;
    if (!bySide) return [];
    return ['red', 'black'].filter((side) => Boolean(bySide[side]));
  }

  resumeMatchAfterReconnect(userId) {
    if (!this.reconnectState) return null;

    const bySide = this.reconnectState.bySide;

    // Đường cũ (không có bySide): giữ hành vi cũ
    if (!bySide) {
      if (Number(this.reconnectState.disconnectedUserId) !== Number(userId)) return null;
      if (this.matchState) {
        this.matchState.isPaused = false;
        this.matchState.turnStartedAt = Date.now();
      }
      const legacyState = { ...this.reconnectState };
      this.reconnectState = null;
      return { room: this.getSummary(), resumedState: legacyState, stillPaused: false };
    }

    const sideKey = ['red', 'black'].find(
      (side) => bySide[side] && Number(bySide[side].disconnectedUserId) === Number(userId),
    );
    if (!sideKey) return null;

    const resumedState = { ...bySide[sideKey] };
    bySide[sideKey] = null;

    const stillDisconnected = ['red', 'black'].some((side) => Boolean(bySide[side]));
    if (stillDisconnected) {
      // BE-06: người còn lại vẫn vắng -> giữ nguyên trạng thái tạm dừng, KHÔNG resume
      this.reconnectState.disconnectedUserId = Number(bySide.red?.disconnectedUserId ?? bySide.black?.disconnectedUserId ?? null);
      const remainingSide = ['red', 'black'].find((side) => bySide[side]);
      if (remainingSide) {
        this.reconnectState.disconnectedSide = bySide[remainingSide].disconnectedSide;
        this.reconnectState.countdownSeconds = bySide[remainingSide].countdownSeconds;
      }
      return { room: this.getSummary(), resumedState, stillPaused: true };
    }

    if (this.matchState) {
      this.matchState.isPaused = false;
      this.matchState.turnStartedAt = Date.now();
    }
    this.reconnectState = null;

    return { room: this.getSummary(), resumedState, stillPaused: false };
  }

  getSnapshot() {
    if (!this.matchState) return null;
    return {
      matchId: this.matchId,
      roomCode: this.code,
      status: this.status === 'FINISHED' ? 'completed' : (this.matchState.status || this.status),
      currentTurn: this.matchState.currentTurn,
      turnRemainingSeconds: this.getRemainingTurnSeconds(),
      turnDurationSeconds: this.matchState.turnDurationSeconds,
      timeControlSeconds: this.matchState.timeControlSeconds,
      plyCount: this.matchState.plyCount,
      viewerCount: this.spectators.length,
      remainingClocks: { ...this.matchState.remainingClocks },
      inCheck: Boolean(this.matchState.inCheck),
      checkedColor: this.matchState.checkedColor,
      board: this.matchState.board,
      capturedPieces: this.matchState.capturedPieces,
      lastMove: this.matchState.lastMove,
      isPaused: Boolean(this.reconnectState),
      reconnectCountdown: this.reconnectState ? this.reconnectState.countdownSeconds : null,
      winner: this.matchState.winner || null,
      endReason: this.matchState.endReason || null,
      players: {
        red: this.players.red,
        black: this.players.black,
      },
    };
  }

  startGame(hostId, matchOptions = {}) {
    this.touch();
    if (hostId && Number(hostId) !== Number(this.hostId)) {
      const err = new Error('Chỉ chủ phòng mới có quyền bắt đầu trận đấu.');
      err.code = 'FORBIDDEN';
      err.statusCode = 403;
      throw err;
    }

    if (this.status === 'PLAYING') {
      return {
        alreadyStarted: true,
        matchId: this.matchId,
        status: this.status,
      };
    }

    if (!this.canStartGame()) {
      const err = new Error('Cả hai người chơi phải ở trạng thái sẵn sàng mới được bắt đầu trận.');
      err.code = 'NOT_ALL_READY';
      err.statusCode = 400;
      throw err;
    }

    this.status = 'PLAYING';
    this.matchId = `MATCH_${this.code}_${Date.now()}`;
    const initialTurnSeconds = matchOptions.turnDurationSeconds || 60;
    const initialClocks = matchOptions.remainingClocks || { red: 300, black: 300 };

    this.matchState = {
      matchId: this.matchId,
      status: 'active',
      currentTurn: 'red',
      plyCount: 0,
      turnDurationSeconds: initialTurnSeconds,
      timeControlSeconds: Math.max(...Object.values(initialClocks).map(Number)),
      turnRemainingSeconds: initialTurnSeconds,
      remainingClocks: { ...initialClocks },
      turnStartedAt: Date.now(),
      isPaused: false,
      board: matchOptions.board || createInitialArmy(),
      capturedPieces: { red: [], black: [] },
      inCheck: false,
      checkedColor: null,
      winner: null,
      endReason: null,
      lastMove: null,
    };
    this.reconnectState = null;

    return {
      alreadyStarted: false,
      matchId: this.matchId,
      status: this.status,
      startedAt: new Date(),
    };
  }

  applyMove(color, from, to) {
    this.touch();
    if (!this.matchState) return { accepted: false, error: 'Chưa có trạng thái trận đấu.' };
    if (this.status !== 'PLAYING' || this.matchState.isPaused) {
      return { accepted: false, error: 'Trận đấu đang tạm dừng hoặc không hoạt động.' };
    }
    if (color !== this.matchState.currentTurn) {
      return { accepted: false, error: 'Chưa tới lượt của bạn.' };
    }

    // SEC-03: chặn toạ độ sai kiểu trước khi sinh nước đi
    if (typeof from !== 'string' || typeof to !== 'string') {
      return { accepted: false, error: 'Toạ độ nước đi không hợp lệ.' };
    }

    const { getLegalMoveError, hasLegalMove, isInCheck } = require('./xiangqiRules');
    const error = getLegalMoveError(this.matchState.board, color, from, to);
    if (error) return { accepted: false, error };

    const capturedPiece = this.matchState.board.find((p) => p.position === to);
    const movingPiece = this.matchState.board.find((p) => p.position === from);
    if (!movingPiece) {
      return { accepted: false, error: 'Không tìm thấy quân cờ ở vị trí xuất phát.' };
    }

    this.matchState.board = this.matchState.board
      .filter((p) => p.position !== to && p.id !== movingPiece.id)
      .concat({ ...movingPiece, position: to });

    if (capturedPiece) {
      if (!this.matchState.capturedPieces[capturedPiece.color]) {
        this.matchState.capturedPieces[capturedPiece.color] = [];
      }
      this.matchState.capturedPieces[capturedPiece.color].push(capturedPiece);
    }

    const nextTurn = color === 'red' ? 'black' : 'red';
    this.matchState.currentTurn = nextTurn;
    this.matchState.turnStartedAt = Date.now();
    this.matchState.turnRemainingSeconds = this.matchState.turnDurationSeconds || 60;
    this.matchState.turnRemainingMs = null; // REV-11: lượt mới đầy đủ
    this.matchState.lastMove = { from, to, color, captured: Boolean(capturedPiece) };

    const inCheck = isInCheck(this.matchState.board, nextTurn);
    this.matchState.inCheck = inCheck;
    this.matchState.checkedColor = inCheck ? nextTurn : null;

    // BE-20: đếm số nước đi, quá giới hạn -> hoà
    this.matchState.plyCount = Number(this.matchState.plyCount || 0) + 1;

    // BE-04: phân biệt CHIẾU BÍ và HẾT NƯỚC ĐI (trước đây luôn ghi 'CHECKMATE')
    let endReason = null;
    if (!hasLegalMove(this.matchState.board, nextTurn)) {
      endReason = inCheck ? 'CHECKMATE' : 'NO_LEGAL_MOVES';
      this.matchState.status = 'completed';
      this.status = 'FINISHED';
      this.matchState.winner = color;
      this.matchState.endReason = endReason;
    }

    // BE-20: hoà khi vượt quá số nước đi tối đa
    if (!endReason && this.matchState.plyCount >= MAX_PLY) {
      endReason = 'DRAW_PLY_LIMIT';
      this.matchState.status = 'completed';
      this.status = 'FINISHED';
      this.matchState.winner = null;
      this.matchState.endReason = endReason;
    }

    return {
      accepted: true,
      captured: Boolean(capturedPiece),
      capturedPiece,
      inCheck,
      endReason,
      winnerColor: endReason && endReason !== 'DRAW_PLY_LIMIT' ? color : null,
      isDraw: endReason === 'DRAW_PLY_LIMIT',
    };
  }

  demoteOpponent(hostId) {
    if (Number(hostId) !== Number(this.hostId)) {
      const err = new Error('Chỉ chủ phòng mới có quyền hạ đối thủ xuống khán giả.');
      err.code = 'FORBIDDEN';
      err.statusCode = 403;
      throw err;
    }

    if (!this.players.black) {
      const err = new Error('Không có đối thủ trong phòng để hạ quyền.');
      err.code = 'NO_OPPONENT';
      err.statusCode = 400;
      throw err;
    }

    if (this.status === 'PLAYING') {
      const err = new Error('Không thể thay đổi vai trò khi trận đấu đang diễn ra.');
      err.code = 'GAME_IN_PROGRESS';
      err.statusCode = 400;
      throw err;
    }

    if (this.spectators.length >= this.maxSpectators) {
      const err = new Error(`Phòng cờ đã đạt giới hạn tối đa ${this.maxSpectators} khán giả.`);
      err.code = 'ROOM_FULL';
      err.statusCode = 409;
      throw err;
    }

    const demoted = this.players.black;
    this.players.black = null;
    this.readyStates.delete(demoted.id);

    this.spectators.push({
      ...demoted,
      joinedAt: new Date(),
    });

    this.status = 'WAITING_OPPONENT';
    return {
      demotedUser: demoted,
      room: this.getSummary(),
    };
  }

  kickParticipant(hostId, targetUserId) {
    const hid = Number(hostId);
    const tid = Number(targetUserId);

    if (hid !== Number(this.hostId)) {
      const err = new Error('Chỉ chủ phòng mới có quyền loại thành viên ra khỏi phòng.');
      err.code = 'FORBIDDEN';
      err.statusCode = 403;
      throw err;
    }

    if (hid === tid) {
      const err = new Error('Chủ phòng không thể tự loại chính mình.');
      err.code = 'CANNOT_KICK_HOST';
      err.statusCode = 400;
      throw err;
    }

    if (this.status === 'PLAYING') {
      const err = new Error('Không thể loại thành viên khi trận đấu đang diễn ra.');
      err.code = 'GAME_IN_PROGRESS';
      err.statusCode = 400;
      throw err;
    }

    let kickedUser = null;
    if (this.players.black && this.players.black.id === tid) {
      kickedUser = this.players.black;
      this.players.black = null;
      this.status = 'WAITING_OPPONENT';
    } else {
      const idx = this.spectators.findIndex((s) => s.id === tid);
      if (idx !== -1) {
        kickedUser = this.spectators[idx];
        this.spectators.splice(idx, 1);
      }
    }

    if (!kickedUser) {
      const err = new Error('Không tìm thấy người dùng này trong phòng.');
      err.code = 'USER_NOT_IN_ROOM';
      err.statusCode = 404;
      throw err;
    }

    this.readyStates.delete(tid);
    this.kickedUsers.add(tid);

    return {
      kickedUser,
      room: this.getSummary(),
    };
  }

  transferHost() {
    const oldHostId = this.hostId;
    let newHost = null;

    // Ưu tiên 1: Đối thủ trở thành Chủ phòng
    if (this.players.black) {
      newHost = this.players.black;
      this.players.red = newHost;
      this.players.black = null;
      this.hostId = newHost.id;
      this.status = 'WAITING_OPPONENT';
    }
    // Ưu tiên 2: Khán giả vào sớm nhất trở thành Chủ phòng
    else if (this.spectators.length > 0) {
      newHost = this.spectators.shift();
      this.players.red = {
        id: newHost.id,
        username: newHost.username,
        displayName: newHost.displayName,
        eloRating: newHost.eloRating ?? 1000,
        avatarUrl: newHost.avatarUrl || null,
      };
      this.hostId = newHost.id;
      this.status = 'WAITING_OPPONENT';
    } else {
      this.players.red = null;
      this.hostId = null;
    }

    // Reset toàn bộ trạng thái sẵn sàng khi có chuyển giao quyền
    this.readyStates.clear();

    return {
      oldHostId,
      newHostId: this.hostId,
      newHost,
      room: this.getSummary(),
    };
  }

  // Quản lý Video Call WebRTC (COT-624, COT-626)
  initiateVideoCall(callerId) {
    const uid = Number(callerId);
    const roleInfo = this.getParticipantRole(uid);
    if (!roleInfo || roleInfo.role !== 'PLAYER') {
      const err = new Error('Khán giả không được bắt đầu, không được tham gia và không được xem cuộc gọi.');
      err.code = 'FORBIDDEN';
      err.statusCode = 403;
      throw err;
    }

    if (!this.players.red || !this.players.black) {
      const err = new Error('Cần có đối thủ trong phòng để thực hiện Video Call.');
      err.code = 'OPPONENT_NOT_FOUND';
      err.statusCode = 400;
      throw err;
    }

    if (this.videoCall && ['RINGING', 'CONNECTED'].includes(this.videoCall.status)) {
      const err = new Error('Mỗi Room chỉ có tối đa một cuộc gọi đang hoạt động.');
      err.code = 'CALL_ALREADY_EXISTS';
      err.statusCode = 409;
      throw err;
    }

    const isRed = this.players.red && Number(this.players.red.id) === uid;
    const opponent = isRed ? this.players.black : this.players.red;
    const calleeId = Number(opponent.id);

    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.videoCall = {
      callId,
      callerId: uid,
      calleeId,
      callerSide: roleInfo.side,
      calleeSide: isRed ? 'BLACK' : 'RED',
      status: 'RINGING',
      startedAt: Date.now(),
      timeoutTimer: null,
    };

    return {
      callId,
      callerId: uid,
      calleeId,
      opponent,
      callerSide: roleInfo.side,
    };
  }

  acceptVideoCall(userId) {
    const uid = Number(userId);
    if (!this.videoCall || this.videoCall.status !== 'RINGING') {
      const err = new Error('Không tìm thấy cuộc gọi đang chờ phản hồi hoặc cuộc gọi đã hết hạn.');
      err.code = 'CALL_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    if (Number(this.videoCall.calleeId) !== uid) {
      const err = new Error('Chỉ người nhận cuộc gọi mới được chấp nhận.');
      err.code = 'FORBIDDEN';
      err.statusCode = 403;
      throw err;
    }

    if (this.videoCall.timeoutTimer) {
      clearTimeout(this.videoCall.timeoutTimer);
      this.videoCall.timeoutTimer = null;
    }

    this.videoCall.status = 'CONNECTED';
    this.videoCall.connectedAt = Date.now();

    return {
      callId: this.videoCall.callId,
      callerId: this.videoCall.callerId,
      calleeId: this.videoCall.calleeId,
    };
  }

  rejectVideoCall(userId, reason = 'REJECTED') {
    const uid = Number(userId);
    if (!this.videoCall || this.videoCall.status !== 'RINGING') {
      const err = new Error('Không tìm thấy cuộc gọi đang chờ phản hồi.');
      err.code = 'CALL_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    if (![Number(this.videoCall.callerId), Number(this.videoCall.calleeId)].includes(uid)) {
      const err = new Error('Bạn không tham gia vào cuộc gọi này.');
      err.code = 'FORBIDDEN';
      err.statusCode = 403;
      throw err;
    }

    if (this.videoCall.timeoutTimer) {
      clearTimeout(this.videoCall.timeoutTimer);
      this.videoCall.timeoutTimer = null;
    }

    const { callId, callerId, calleeId } = this.videoCall;
    this.videoCall = null;

    return {
      callId,
      callerId,
      calleeId,
      reason,
      cancelledByCaller: uid === Number(callerId),
    };
  }

  endVideoCall(userId = null, reason = 'USER_HANGUP') {
    if (!this.videoCall) return null;

    if (this.videoCall.timeoutTimer) {
      clearTimeout(this.videoCall.timeoutTimer);
      this.videoCall.timeoutTimer = null;
    }

    const prevCall = { ...this.videoCall };
    this.videoCall = null;

    return {
      callId: prevCall.callId,
      callerId: prevCall.callerId,
      calleeId: prevCall.calleeId,
      endedBy: userId ? Number(userId) : null,
      reason,
    };
  }
}

module.exports = Room;
