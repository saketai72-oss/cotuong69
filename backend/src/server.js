// SEC-02: nạp .env trước mọi require khác để JWT_SECRET/DB_* có sẵn khi module đọc cấu hình
require('dotenv').config();

const http = require('node:http');
const { URL } = require('node:url');
const { WebSocketServer } = require('ws');
const {
  applyMatchMove,
  checkClockTimeout,
  createCot615Match,
  getPublicMatchState,
  startCot615Match,
} = require('./domain/entities/cot615Match');
const { getLegalMoveDestinations } = require('./domain/entities/xiangqiRules');
const { createMatchesHandler } = require('./presentation/http/routes/matches.routes');
const { createAuthHandler } = require('./presentation/http/routes/auth.routes');
const { createUserHandler } = require('./presentation/http/routes/user.routes');
const { createRoomHandler } = require('./presentation/http/routes/room.routes');
const { createFriendsHandler } = require('./presentation/http/routes/friends.routes');
const { createPveHandler } = require('./presentation/http/routes/pve.routes');
const { createPveService } = require('./application/use-cases/game/pve/pveService');
const { createPveSweeper } = require('./application/use-cases/game/pve/pveSweeper');
const { roomHub: defaultRoomHub, WS_SUBPROTOCOL } = require('./presentation/websocket/roomHub');
const { DemoCallRelay, isCallMessageType } = require('./presentation/websocket/demoCallRelay');
const { DemoChatRelay, isChatMessageType } = require('./presentation/websocket/demoChatRelay');
const { getClientIp, roomLookupLimiter } = require('./presentation/http/middlewares/rateLimiter');
const fs = require('node:fs');
const path = require('node:path');
const { assertJwtSecretConfigured } = require('./application/services/tokenService');

/**
 * BE-11: endpoint trận mẫu COT-615 không xác thực -> chỉ bật khi ENABLE_DEMO_MATCH=true.
 * Mặc định TẮT.
 */
function demoMatchEnabled() {
  return process.env.ENABLE_DEMO_MATCH === 'true';
}

/**
 * REV-19: đồng hồ mỗi bên của trận demo (giây). Mặc định 600 để demo không bị gấp;
 * kẹp trong [30, 3600].
 */
function demoClockSeconds() {
  const value = Number(process.env.DEMO_CLOCK_SECONDS);
  if (!Number.isFinite(value) || value <= 0) return 600;
  return Math.min(3600, Math.max(30, Math.floor(value)));
}

// REV-19: trận demo kết thúc xong thì tự mở ván mới sau chừng này mili-giây
const DEMO_RESET_DELAY_MS = 10 * 1000;

// SEC-03: không để một promise bị reject làm chết cả server
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

function createServer(options = {}) {
  let match = options.match || null;
  const now = options.now || (() => Date.now());
  const clients = new Map();
  // BE-07: giới hạn payload 64KB cho WS trận mẫu
  // FE-06: nếu client gửi Sec-WebSocket-Protocol (kèm token) thì chỉ chọn 'cotuong.v1', không echo token
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
  });
  const roomHub = options.roomHub || defaultRoomHub;
  // REV-19: chỉ trận do server tạo (không phải match test truyền vào) mới tự reset ván mới
  const autoResetMatch = !options.match;
  const newDemoMatch = () => createCot615Match(now(), {
    waitForPlayers: true,
    clockSeconds: demoClockSeconds(),
  });
  const getCurrentMatch = () => {
    if (!match) {
      // REV-19: đồng hồ chỉ chạy khi cả Đỏ và Đen đã kết nối (xem maybeStartMatch)
      match = newDemoMatch();
      maybeStartMatch();
    } else if (autoResetMatch) {
      resetFinishedMatchIfDue();
    }
    return match;
  };

  // REV-19: đủ 2 người chơi (Đỏ + Đen) mới bắt đầu đếm ngược/chạy đồng hồ
  function maybeStartMatch() {
    if (!match) return;
    const occupied = new Set([...clients.values()].filter(Boolean));
    if (occupied.has('red') && occupied.has('black')) startCot615Match(match, now());
  }

  // REV-19: ván demo kết thúc quá 10 giây thì mở ván mới (không phải restart backend)
  function resetFinishedMatchIfDue() {
    checkClockTimeout(match, now());
    if (match.status !== 'completed') return;
    const finishedAt = Date.parse(match.finishedAt);
    if (Number.isFinite(finishedAt) && now() - finishedAt < DEMO_RESET_DELAY_MS) return;
    match = newDemoMatch();
    maybeStartMatch();
  }
  const matchesHandler = createMatchesHandler({
    getMatch: getCurrentMatch,
    now,
  });
  const authHandler = options.authHandler || createAuthHandler(options.authOptions);
  const userHandler = options.userHandler || createUserHandler(options.userOptions);
  const roomHandler = options.roomHandler || createRoomHandler(options.roomOptions);
  const friendsHandler = options.friendsHandler || createFriendsHandler(options.friendsOptions);
  // FE-10: API chơi với máy + sweeper (máy đi bù / xử hết giờ). Sweeper chỉ chạy khi gọi
  // server.pveSweeper.start() (lúc khởi động thật) để test không phải đụng DB.
  const pveService = options.pveService || createPveService(options.pveOptions);
  const pveHandler = options.pveHandler || createPveHandler({ service: pveService, ...options.pveHandlerOptions });
  const pveSweeper = options.pveSweeper || createPveSweeper({ service: pveService, ...options.pveSweeperOptions });

  const routeRequest = (req, res) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'URL không hợp lệ' }));
      return;
    }

    if (pathname.startsWith('/api/auth')) {
      return authHandler(req, res);
    }
    if (pathname.startsWith('/api/users')) {
      return userHandler(req, res);
    }
    if (pathname.startsWith('/api/rooms')) {
      return roomHandler(req, res);
    }
    if (pathname.startsWith('/api/friends')) {
      return friendsHandler(req, res);
    }
    if (pathname.startsWith('/api/pve')) {
      return pveHandler(req, res);
    }
    if (pathname.startsWith('/uploads/')) {
      return serveUpload(pathname, res);
    }
    if (!demoMatchEnabled()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Route not found' }));
      return;
    }

    return matchesHandler(req, res);
  };

  // SEC-03: chỉ phục vụ file thật nằm trong thư mục uploads, chặn path traversal/EISDIR
  const uploadRoot = path.resolve(__dirname, '..', 'uploads');
  function serveUpload(pathname, res) {
    let relativePath;
    try {
      relativePath = decodeURIComponent(pathname.slice('/uploads/'.length));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ error: 'Đường dẫn tệp không hợp lệ.' }));
      return;
    }

    if (!relativePath || relativePath.includes('\0')) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ error: 'Đường dẫn tệp không hợp lệ.' }));
      return;
    }

    const filePath = path.resolve(uploadRoot, relativePath);
    const insideRoot = filePath === uploadRoot || filePath.startsWith(uploadRoot + path.sep);
    if (!insideRoot) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ error: 'Truy cập bị từ chối.' }));
      return;
    }

    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify({ error: 'Không tìm thấy tệp.' }));
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': mimeMap[ext] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      });
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  }

  function handleHttpError(err, res) {
    console.error('[HTTP]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ success: false, code: 'INTERNAL_ERROR' }));
    }
  }

  // SEC-03: mọi handler bất đồng bộ đều được bọc, một request xấu không kill process
  const httpHandler = (req, res) => {
    try {
      const result = routeRequest(req, res);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => handleHttpError(err, res));
      }
    } catch (err) {
      handleHttpError(err, res);
    }
  };

  const server = http.createServer(httpHandler);

  function send(client, message) {
    if (client.readyState === 1) client.send(JSON.stringify(message));
  }

  function broadcastState() {
    if (!match) return;
    getCurrentMatch(); // REV-19: có thể tự reset ván đã kết thúc
    const state = getPublicMatchState(match, now());
    for (const [client, color] of clients) {
      send(client, { type: 'state', state, color, readOnly: color === null });
    }
  }

  // FE-01: relay call:* giữa hai người cầm Đỏ/Đen của trận demo (khán giả không tham gia)
  const callRelay = new DemoCallRelay({
    findClient: (color) => {
      for (const [socket, seat] of clients) {
        if (seat === color) return socket;
      }
      return null;
    },
    getName: (color) => {
      const player = getCurrentMatch().players && getCurrentMatch().players[color];
      return (player && player.name) || (color === 'red' ? 'Quân Đỏ' : 'Quân Đen');
    },
    send,
  });

  // FE-05: relay chat:send tới mọi người trong trận demo (kể cả khán giả)
  const chatRelay = new DemoChatRelay({ listClients: () => clients.keys(), send });

  function assignColor() {
    const occupied = new Set([...clients.values()].filter(Boolean));
    return ['red', 'black'].find((color) => !occupied.has(color)) || null;
  }

  function handleMessage(client, rawMessage) {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      send(client, { type: 'error', error: 'Dữ liệu gửi lên không hợp lệ.' });
      return;
    }

    // FE-01: tín hiệu WebRTC đi qua socket trận demo
    if (isCallMessageType(message?.type)) {
      callRelay.handle(client, clients.get(client) || null, message);
      return;
    }

    // FE-05: chat văn bản đi qua socket trận demo
    if (isChatMessageType(message?.type)) {
      chatRelay.handle(client, clients.get(client) || null, message);
      return;
    }

    if (message?.type === 'legalMoves') {
      const color = clients.get(client);
      const currentMatch = getCurrentMatch();
      const state = getPublicMatchState(currentMatch, now());
      const destinations = color && state.status === 'active' &&
        currentMatch.currentTurn === color && typeof message.from === 'string'
        ? getLegalMoveDestinations(currentMatch.board, color, message.from)
        : [];
      send(client, { type: 'legalMovesResult', from: message.from, destinations });
      return;
    }

    if (message?.type !== 'move' || typeof message.from !== 'string' || typeof message.to !== 'string') {
      send(client, { type: 'error', error: 'Yêu cầu nước đi không hợp lệ.' });
      return;
    }

    const color = clients.get(client);
    if (!color) {
      send(client, { type: 'moveResult', accepted: false, error: 'Khán giả không thể đi quân.' });
      return;
    }

    const result = applyMatchMove(getCurrentMatch(), color, message.from, message.to, now());
    if (result.accepted) broadcastState();
    send(client, { type: 'moveResult', ...result });
  }

  server.on('upgrade', (request, socket, head) => {
    // REV2-01: socket upgrade thô không có listener 'error' mặc định; client reset TCP
    // (ECONNRESET) sẽ thành uncaughtException. ws gắn listener của nó khi nhận socket.
    const onUpgradeSocketError = () => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    };
    socket.on('error', onUpgradeSocketError);

    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname === '/ws/room' || pathname.startsWith('/ws/room/')) {
      // REV-04: chặn dò mã phòng qua WS upgrade (trước đây dò vô hạn, phân biệt
      // được mã tồn tại/không tồn tại qua 101 vs 404)
      // Chỉ CHẶN khi IP đã vượt hạn mức (không consume ở đây): lượt dò mã phòng
      // chỉ bị đếm khi mã KHÔNG tồn tại (404) trong roomHub.handleUpgrade.
      const lookupKey = `room-lookup:${getClientIp(request)}`;
      if (roomLookupLimiter.isBlocked(lookupKey)) {
        try {
          socket.write('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\nConnection: close\r\n\r\n');
        } catch {
          /* ignore */
        }
        socket.destroy();
        return;
      }

      // REV-05: handleUpgrade nay là async (kiểm tra phiên trong DB)
      Promise.resolve(roomHub.handleUpgrade(request, socket, head)).catch((err) => {
        console.error('[WS] lỗi upgrade:', err);
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }).finally(() => socket.removeListener('error', onUpgradeSocketError));
      return;
    }

    const matchRoute = pathname.match(/^\/api\/matches\/([^/]+)\/ws$/);
    if (!matchRoute || !demoMatchEnabled()) {
      socket.destroy();
      return;
    }

    let requestedMatchId;
    try {
      requestedMatchId = decodeURIComponent(matchRoute[1]);
    } catch {
      socket.destroy();
      return;
    }
    if (requestedMatchId !== getCurrentMatch().id) {
      socket.destroy();
      return;
    }

    webSockets.handleUpgrade(request, socket, head, (client) => {
      webSockets.emit('connection', client);
    });
    socket.removeListener('error', onUpgradeSocketError);
  });

  webSockets.on('connection', (client) => {
    const color = assignColor();
    clients.set(client, color);
    maybeStartMatch(); // REV-19: người thứ hai vào -> bắt đầu đếm ngược
    send(client, {
      type: 'welcome',
      color,
      readOnly: color === null,
      state: getPublicMatchState(getCurrentMatch(), now()),
    });
    broadcastState();
    client.on('error', (err) => {
      console.warn('[WS] Lỗi socket match:', err && err.message);
      try {
        client.terminate();
      } catch {
        /* ignore */
      }
    });
    client.on('message', (message) => {
      try {
        handleMessage(client, message);
      } catch (err) {
        console.error('[WS] Lỗi xử lý tin nhắn match:', err);
        send(client, { type: 'error', error: 'Không xử lý được tin nhắn.' });
      }
    });
    client.on('close', () => {
      const seat = clients.get(client);
      clients.delete(client);
      chatRelay.forget(client);
      callRelay.handleSeatLeft(seat); // FE-01: người trong cuộc gọi rớt -> báo bên còn lại
      broadcastState();
    });
  });

  const clockTimer = setInterval(broadcastState, 1000);
  clockTimer.unref();

  server.pveSweeper = pveSweeper;
  server.on('close', () => {
    clearInterval(clockTimer);
    pveSweeper.stop();
    callRelay.close();
    // BE-07: dọn heartbeat/timer của roomHub khi server đóng
    if (roomHub && typeof roomHub.close === 'function') roomHub.close();
    for (const client of webSockets.clients) client.close();
    webSockets.close();
  });

  return server;
}

if (require.main === module) {
  // SEC-02: thiếu hoặc quá ngắn JWT_SECRET → dừng ngay, không chạy với secret không an toàn
  try {
    assertJwtSecretConfigured();
  } catch (err) {
    console.error(`[FATAL] ${err.message}`);
    console.error('Sinh secret bằng: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
    process.exit(1);
  }

  const port = Number(process.env.PORT || 5000);
  const server = createServer();

  // SEC-01: Cảnh báo rõ khi mock OAuth đang bật (chỉ dev/demo)
  if (process.env.ALLOW_MOCK_OAUTH === 'true' && process.env.NODE_ENV !== 'production') {
    console.warn('[OAuth] MOCK OAUTH ĐANG BẬT — chỉ dùng cho dev/demo');
  }

  server.pveSweeper.start(); // FE-10: máy đi bù / xử hết giờ cho trận PvE bỏ dở
  server.listen(port, '127.0.0.1', () => {
    console.log(`Match API listening on http://localhost:${port}`);
    console.log('Development match: GET /api/matches/COT-615; WebSocket /api/matches/COT-615/ws');
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close((error) => {
        if (error) {
          console.error('Failed to close Match API server:', error);
          process.exitCode = 1;
        }
      });
    });
  }
}

module.exports = { createServer };
