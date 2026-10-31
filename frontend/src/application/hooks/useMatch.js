import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchMatch, matchWebSocketProtocols, matchWebSocketUrl } from '../../infrastructure/api/matchApi';
import { ReconnectManager } from '../../domain/network/reconnectManager';
import { BoardSyncManager } from '../../domain/game/boardSyncManager';
import { classifyServerMessage } from '../../domain/network/signalingMessages';
import { useRoomSignaling } from './useRoomSignaling';
import {
  browserOnlineAction,
  isFatalCloseCode,
  isFatalHttpStatus,
  nextRetryDelay,
  resolveReadOnly,
} from '../../domain/network/reconnectPolicy';

const SIGNALING_LOST_MESSAGE = {
  type: 'CallEnded',
  reason: 'SIGNALING_LOST',
  message: 'Mất kết nối máy chủ nên cuộc gọi video đã kết thúc.',
};

function isMatchColor(color) {
  return color === 'red' || color === 'black';
}

function moveKey(lastMove) {
  if (!lastMove) return null;
  return `${lastMove.color}:${lastMove.from}:${lastMove.to}:${Boolean(lastMove.captured)}`;
}

function withCheckStatus(serverState, message, previousMatch) {
  if (!serverState) return serverState;

  const checkValue = typeof serverState.check === 'boolean'
    ? serverState.check
    : typeof serverState.inCheck === 'boolean'
      ? serverState.inCheck
      : typeof message.check === 'boolean'
        ? message.check
        : typeof message.inCheck === 'boolean'
          ? message.inCheck
          : null;
  const reportedColor = isMatchColor(serverState.checkedColor)
    ? serverState.checkedColor
    : isMatchColor(message.checkedColor)
      ? message.checkedColor
      : null;
  const hasReportedStatus = checkValue !== null || reportedColor !== null;

  if (hasReportedStatus) {
    const isChecked = checkValue ?? Boolean(reportedColor);
    return {
      ...serverState,
      check: isChecked,
      checkedColor: isChecked ? reportedColor || serverState.currentTurn : null,
    };
  }

  const sameMove = moveKey(serverState.lastMove) === moveKey(previousMatch?.lastMove);
  return {
    ...serverState,
    check: sameMove ? Boolean(previousMatch?.check) : false,
    checkedColor: sameMove ? previousMatch?.checkedColor || null : null,
  };
}

/**
 * @param {string|null} matchId
 * @param {{roomCode?: string|null}} [options] Có roomCode thì game, chat và cuộc gọi dùng
 *   roomHub (/ws/room/:code); chỉ có matchId thì dùng WebSocket trận demo.
 */
export function useMatch(matchId, { roomCode = null } = {}) {
  const reconnectManager = useMemo(() => new ReconnectManager({ maxWaitSeconds: 60 }), []);
  const [reconnectState, setReconnectState] = useState(() => reconnectManager.getState());

  const [state, setState] = useState({
    match: null,
    loading: Boolean(matchId || roomCode),
    error: null,
    color: null,
    readOnly: true,
    connected: false,
    movePending: false,
    moveError: null,
    moveResult: null,
    legalMoves: null,
  });
  const socketRef = useRef(null);
  const pendingRef = useRef(false);
  const signalingHandlerRef = useRef(null);
  const deliverSignaling = useCallback((message) => {
    if (typeof signalingHandlerRef.current === 'function') {
      signalingHandlerRef.current(message);
    }
  }, []);
  // FE-05: tin chat (ChatMessage / ChatError) đi cùng hai kênh với signaling cuộc gọi
  const chatHandlerRef = useRef(null);
  const deliverChat = useCallback((message) => {
    if (typeof chatHandlerRef.current === 'function') {
      chatHandlerRef.current(message);
    }
  }, []);
  const handleRoomMessage = useCallback((message) => {
    if (message.type === 'RoomDisconnected') {
      reconnectManager.handleSelfDisconnect('ROOM_SOCKET_DISCONNECTED');
      pendingRef.current = false;
      setState((current) => ({
        ...current,
        connected: false,
        movePending: false,
        legalMoves: null,
      }));
      return;
    }

    if (message.type === 'Connected' || message.type === 'reconnectState' || message.type === 'GameStarted') {
      reconnectManager.handleSelfReconnect();
      const side = message.side || message.room?.side;
      const normalizedSide = typeof side === 'string' ? side.toLowerCase() : null;
      const assignedColor = isMatchColor(normalizedSide) ? normalizedSide : null;
      const hasRole = message.type !== 'GameStarted';
      const readOnly = hasRole ? message.role === 'SPECTATOR' || !assignedColor : null;
      const snapshot = message.snapshot || message.state;
      setState((current) => {
        const restoredMatch = snapshot
          ? BoardSyncManager.restoreFromSnapshot(snapshot, current.match)
          : current.match;
        return {
          ...current,
          match: restoredMatch ? withCheckStatus(restoredMatch, message, current.match) : null,
          color: assignedColor || current.color,
          readOnly: readOnly === null ? current.readOnly : readOnly,
          loading: snapshot ? false : current.loading,
          connected: true,
          error: null,
        };
      });
      if (message.type === 'GameStarted') reconnectManager.clearServerResult();
      return;
    }

    if (message.type === 'legalMovesResult') {
      setState((current) => ({
        ...current,
        legalMoves: {
          from: message.from,
          destinations: Array.isArray(message.destinations) ? message.destinations : [],
        },
      }));
      return;
    }

    if (message.type === 'moveResult') {
      pendingRef.current = false;
      setState((current) => {
        const snapshot = message.snapshot || message.state;
        const restoredMatch = snapshot
          ? BoardSyncManager.restoreFromSnapshot(snapshot, current.match)
          : current.match;
        return {
          ...current,
          movePending: false,
          moveError: message.accepted ? null : message.error,
          moveResult: message.accepted ? message : null,
          legalMoves: null,
          match: restoredMatch ? withCheckStatus(restoredMatch, message, current.match) : null,
        };
      });
      return;
    }

    if (message.type === 'opponentDisconnected') {
      reconnectManager.handleOpponentDisconnect({
        player: message.player || 'opponent',
        countdownSeconds: message.countdownSeconds || 60,
      });
      return;
    }

    if (message.type === 'opponentReconnected') {
      reconnectManager.handleOpponentReconnect();
      if (message.snapshot || message.state) {
        setState((current) => {
          const restoredMatch = BoardSyncManager.restoreFromSnapshot(
            message.snapshot || message.state,
            current.match,
          );
          return {
            ...current,
            match: withCheckStatus(restoredMatch, message, current.match),
          };
        });
      }
      return;
    }

    if (message.type === 'matchEnded' || message.type === 'match:ended') {
      reconnectManager.handleServerMatchResult({
        winner: message.winner,
        winnerColor: message.winnerColor,
        reason: message.reason || message.endReason,
        message: message.message,
      });
      if (message.snapshot) {
        setState((current) => {
          const restoredMatch = BoardSyncManager.restoreFromSnapshot(message.snapshot, current.match);
          return {
            ...current,
            match: withCheckStatus(restoredMatch, message, current.match),
          };
        });
      }
      return;
    }

    const routed = classifyServerMessage(message, { movePending: pendingRef.current });
    if (routed.kind === 'moveError') {
      pendingRef.current = false;
      setState((current) => ({ ...current, movePending: false, moveError: routed.error }));
    } else if (message.type === 'error') {
      setState((current) => ({ ...current, error: message.message || message.error || 'Máy chủ từ chối yêu cầu.' }));
    }
  }, [reconnectManager]);
  const roomSignaling = useRoomSignaling(roomCode, deliverSignaling, deliverChat, handleRoomMessage);
  const sendRoomMessage = roomSignaling.send;
  const isRoomSocketReady = roomSignaling.isReady;
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;
  // FE-08: sự kiện `online` của trình duyệt gọi hàm này để kết nối lại NGAY (không chờ backoff)
  const reconnectNowRef = useRef(null);

  // Lắng nghe thay đổi trạng thái từ ReconnectManager
  useEffect(() => {
    const unsubscribe = reconnectManager.subscribe((next) => {
      setReconnectState({ ...next });
    });
    return () => {
      unsubscribe();
      reconnectManager.destroy();
    };
  }, [reconnectManager]);

  // Lắng nghe sự kiện offline / online của trình duyệt
  useEffect(() => {
    function handleBrowserOnline() {
      // FE-08: `online` chưa có nghĩa WebSocket đã sống lại -> chỉ mở khóa bàn cờ khi socket
      // thật sự OPEN; ngược lại kết nối lại ngay và giữ nguyên trạng thái khóa.
      const socket = socketRef.current;
      const socketOpen = Boolean(socket && socket.readyState === WebSocket.OPEN);
      if (browserOnlineAction({ socketOpen }) === 'MARK_CONNECTED') {
        reconnectManager.handleSelfReconnect();
      } else if (typeof reconnectNowRef.current === 'function') {
        reconnectNowRef.current();
      }
    }
    function handleBrowserOffline() {
      reconnectManager.handleSelfDisconnect('BROWSER_OFFLINE');
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleBrowserOnline);
      window.addEventListener('offline', handleBrowserOffline);
      if (window.navigator && window.navigator.onLine === false) {
        reconnectManager.handleSelfDisconnect('NAVIGATOR_OFFLINE');
      }
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleBrowserOnline);
        window.removeEventListener('offline', handleBrowserOffline);
      }
    };
  }, [reconnectManager]);

  useEffect(() => {
    if (roomCode) {
      return undefined;
    }
    if (!matchId) {
      return undefined;
    }

    let cancelled = false;
    let retryTimeout;
    let attempt = 0; // FE-08: số lần thất bại liên tiếp, dùng cho backoff có jitter
    let inFlight = false;
    let lastMatchStatus = null; // REV2-10: trạng thái ván ở message state/welcome gần nhất
    let controller = new AbortController();
    let socket;

    function scheduleRetry() {
      window.clearTimeout(retryTimeout);
      retryTimeout = window.setTimeout(connect, nextRetryDelay(attempt));
      attempt += 1;
    }

    async function connect() {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const match = await fetchMatch(matchId, { signal: controller.signal });
        inFlight = false;
        if (cancelled) return;
        setState((current) => ({ ...current, match, loading: false, error: null }));

        // FE-06: token gửi qua Sec-WebSocket-Protocol thay vì query string
        // REV2-12: mỗi handler gắn với ĐÚNG socket này; sự kiện muộn của socket cũ (đang CLOSING
        // khi socket mới đã mở) phải bị bỏ qua, nếu không close của socket cũ xoá socketRef của
        // socket mới và kích hoạt thêm một lần kết nối lại -> socket thứ 3, socket thứ 2 giữ ghế.
        const ws = new WebSocket(matchWebSocketUrl(matchId), matchWebSocketProtocols());
        socket = ws;
        socketRef.current = ws;
        const isCurrent = () => socketRef.current === ws;
        ws.addEventListener('open', () => {
          if (!cancelled && isCurrent()) {
            attempt = 0;
            reconnectManager.handleSelfReconnect();
            setState((current) => ({ ...current, connected: true, error: null }));
          }
        });
        ws.addEventListener('message', (event) => {
          if (cancelled || !isCurrent()) return;
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'reconnectState') {
              // COT-602: Khôi phục toàn diện bàn cờ, quân bị ăn, đồng hồ, lượt đi và trạng thái chiếu từ snapshot máy chủ
              reconnectManager.handleSelfReconnect();
              setState((current) => {
                const restoredMatch = BoardSyncManager.restoreFromSnapshot(
                  message.snapshot || message.state,
                  current.match,
                );
                const assignedColor = message.side
                  ? message.side.toLowerCase()
                  : message.role === 'host'
                    ? 'red'
                    : message.role === 'guest'
                      ? 'black'
                      : current.color;
                const readOnly = message.role === 'spectator' ||
                  (message.readOnly !== undefined ? message.readOnly : current.readOnly);
                return {
                  ...current,
                  match: withCheckStatus(restoredMatch, message, current.match),
                  color: assignedColor || current.color,
                  readOnly,
                  loading: false,
                  connected: true,
                  error: null,
                };
              });
            } else if (message.type === 'welcome' || message.type === 'state') {
              setState((current) => ({
                ...current,
                match: withCheckStatus(message.state, message, current.match),
                color: message.color,
                // FE-08: thiếu readOnly thì suy từ màu (khán giả không có màu) thay vì undefined
                readOnly: resolveReadOnly(message),
                loading: false,
                connected: true,
                error: null,
              }));
              // REV2-10: chỉ xử lý kết quả khi CHUYỂN vào 'completed'; khi trạng thái rời 'completed'
              // (demo tự reset ván mới) phải bỏ kết quả cũ, nếu không cả hai bàn bị khoá mãi.
              const nextStatus = message.state?.status;
              if (nextStatus === 'completed') {
                if (lastMatchStatus !== 'completed' && message.state?.winner &&
                  !reconnectManager.serverResult) {
                  reconnectManager.handleServerMatchResult({
                    winner: message.state.winner,
                    reason: message.state.endReason || 'COMPLETED',
                  });
                }
              } else if (nextStatus) {
                reconnectManager.clearServerResult();
              }
              if (nextStatus) lastMatchStatus = nextStatus;
            } else if (
              message.type === 'opponentDisconnected' ||
              message.type === 'match:opponentDisconnected'
            ) {
              // COT-601: Đối thủ mất kết nối -> kích hoạt đếm ngược 60s & dừng đồng hồ lượt
              reconnectManager.handleOpponentDisconnect({
                player: message.player || 'opponent',
                countdownSeconds: message.countdownSeconds || 60,
              });
            } else if (
              message.type === 'opponentReconnected' ||
              message.type === 'match:opponentReconnected' ||
              message.type === 'PlayerReconnected'
            ) {
              // COT-601 & COT-602: Đối thủ kết nối lại kịp thời -> tắt banner, khôi phục bàn cờ & tiếp tục ván đấu
              reconnectManager.handleOpponentReconnect();
              if (message.snapshot || message.state) {
                setState((current) => {
                  const restoredMatch = BoardSyncManager.restoreFromSnapshot(
                    message.snapshot || message.state,
                    current.match,
                  );
                  return {
                    ...current,
                    match: withCheckStatus(restoredMatch, message, current.match),
                  };
                });
              }
            } else if (message.type === 'matchEnded' || message.type === 'match:ended') {
              // COT-601: Máy chủ chốt kết quả kết thúc trận
              reconnectManager.handleServerMatchResult({
                winner: message.winner,
                winnerColor: message.winnerColor,
                reason: message.reason || message.endReason,
                message: message.message,
              });
            } else if (message.type === 'moveResult') {
              pendingRef.current = false;
              setState((current) => {
                const nextMatch = message.state || current.match;
                const match = nextMatch && typeof message.check === 'boolean'
                  ? {
                    ...nextMatch,
                    check: message.check,
                    checkedColor: message.check
                      ? nextMatch.currentTurn || null
                      : null,
                  }
                  : nextMatch;
                return {
                  ...current,
                  movePending: false,
                  moveError: message.accepted ? null : message.error,
                  moveResult: message.accepted ? message : null,
                  legalMoves: null,
                  match,
                };
              });
            } else if (message.type === 'legalMovesResult') {
              setState((current) => ({
                ...current,
                legalMoves: {
                  from: message.from,
                  destinations: Array.isArray(message.destinations) ? message.destinations : [],
                },
              }));
            } else if (message.type === 'error' || ['call', 'chat'].includes(classifyServerMessage(message).kind)) {
              // FE-01: gói Call* và lỗi của cuộc gọi đi tới CallController (COT-629);
              // FE-05: ChatMessage và lỗi chat đi tới khung chat;
              // lỗi chung chỉ thành moveError khi đang có nước đi chờ phản hồi.
              const routed = classifyServerMessage(message, { movePending: pendingRef.current });
              if (routed.kind === 'call') {
                deliverSignaling(routed.message);
              } else if (routed.kind === 'chat') {
                deliverChat(routed.message);
              } else if (routed.kind === 'moveError') {
                pendingRef.current = false;
                setState((current) => ({ ...current, movePending: false, moveError: routed.error }));
              }
            }
          } catch (error) {
            setState((current) => ({
              ...current,
              error: `Phản hồi máy chủ không hợp lệ: ${error.message}`,
            }));
          }
        });
        ws.addEventListener('close', (event) => {
          if (cancelled || !isCurrent()) return;
          socketRef.current = null;
          pendingRef.current = false;
          // COT-601: Mất kết nối WebSocket -> hiển thị overlay mạng chập chờn
          reconnectManager.handleSelfDisconnect('WS_DISCONNECTED');
          // FE-01: signaling của cuộc gọi đi qua chính socket này (trận demo) -> mất socket là
          // mất cuộc gọi phía server; báo cho CallController dọn camera/mic.
          if (!roomCodeRef.current) deliverSignaling(SIGNALING_LOST_MESSAGE);
          // FE-08: server chủ động từ chối (1008 / 4xxx) thì không thử lại vô hạn
          if (isFatalCloseCode(event && event.code)) {
            setState((current) => ({
              ...current,
              connected: false,
              movePending: false,
              error: 'Máy chủ từ chối kết nối thời gian thực.',
            }));
            return;
          }
          setState((current) => ({
            ...current,
            connected: false,
            movePending: false,
            error: 'Mất kết nối thời gian thực — đang kết nối lại.',
          }));
          scheduleRetry();
        });
        ws.addEventListener('error', () => {
          if (!cancelled && isCurrent()) {
            reconnectManager.handleSelfDisconnect('WS_ERROR');
            setState((current) => ({
              ...current,
              error: 'Không thể kết nối tới máy chủ thời gian thực.',
            }));
          }
        });
      } catch (error) {
        inFlight = false;
        if (!cancelled && error.name !== 'AbortError') {
          // FE-08: lỗi 4xx (chưa đăng nhập, không có trận...) thử lại cũng vô ích -> dừng
          const fatal = isFatalHttpStatus(error.status);
          if (!fatal) reconnectManager.handleSelfDisconnect('FETCH_FAILED');
          setState((current) => ({
            ...current,
            loading: false,
            error: error.message || 'Không thể kết nối tới máy chủ trận đấu.',
          }));
          if (!fatal) scheduleRetry();
        }
      }
    }

    reconnectNowRef.current = () => {
      if (cancelled) return;
      const current = socketRef.current;
      if (current && current.readyState === WebSocket.OPEN) {
        reconnectManager.handleSelfReconnect();
        return;
      }
      // REV2-12: socket đang CLOSING sắp phát 'close' (sẽ tự lên lịch kết nối lại) -> coi như
      // CONNECTING, không mở thêm socket song song.
      if (current && (current.readyState === WebSocket.CONNECTING || current.readyState === WebSocket.CLOSING)) return;
      window.clearTimeout(retryTimeout);
      attempt = 0;
      connect();
    };

    connect();

    return () => {
      cancelled = true;
      window.clearTimeout(retryTimeout);
      controller.abort();
      socket?.close();
      socketRef.current = null;
      pendingRef.current = false;
      reconnectNowRef.current = null;
      // FE-08: KHÔNG destroy() ở đây — destroy xoá luôn listener UI (đã đăng ký ở effect khác),
      // đổi matchId xong giao diện sẽ không còn nhận cập nhật. Chỉ dừng đếm ngược.
      reconnectManager.stopCountdownTimer();
    };
  }, [matchId, roomCode, reconnectManager]);

  const sendMove = useCallback((from, to) => {
    // COT-601 AC 2: Khóa toàn bộ thao tác gửi nước đi khi đang mất kết nối
    // FE-08: trả false thì phải báo lỗi cho người chơi thay vì im lặng
    if (!reconnectManager.canMakeMove()) {
      setState((current) => ({ ...current, moveError: 'Chưa thể đi quân lúc này (đang tạm khóa do mất kết nối hoặc ván đã kết thúc).' }));
      return false;
    }
    const socket = socketRef.current;
    const roomReady = roomCode && isRoomSocketReady();
    if ((!roomCode && (!socket || socket.readyState !== WebSocket.OPEN)) || (roomCode && !roomReady)) {
      setState((current) => ({ ...current, moveError: 'Chưa kết nối máy chủ nên chưa gửi được nước đi.' }));
      return false;
    }
    if (pendingRef.current) {
      setState((current) => ({ ...current, moveError: 'Đang chờ máy chủ xác nhận nước đi trước.' }));
      return false;
    }
    pendingRef.current = true;
    setState((current) => ({ ...current, movePending: true, moveError: null, moveResult: null }));
    if (roomCode) {
      if (!sendRoomMessage({ type: 'move', from, to })) {
        pendingRef.current = false;
        setState((current) => ({ ...current, movePending: false, moveError: 'Chưa kết nối máy chủ nên chưa gửi được nước đi.' }));
        return false;
      }
    } else {
      socket.send(JSON.stringify({ type: 'move', from, to }));
    }
    return true;
  }, [reconnectManager, roomCode, isRoomSocketReady, sendRoomMessage]);

  const requestLegalMoves = useCallback((from) => {
    if (roomCode) {
      if (!isRoomSocketReady()) {
        setState((current) => ({ ...current, legalMoves: null }));
        return false;
      }
      setState((current) => ({ ...current, legalMoves: null }));
      return sendRoomMessage({ type: 'legalMoves', from });
    }
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setState((current) => ({ ...current, legalMoves: null }));
      return false;
    }
    setState((current) => ({ ...current, legalMoves: null }));
    socket.send(JSON.stringify({ type: 'legalMoves', from }));
    return true;
  }, [roomCode, isRoomSocketReady, sendRoomMessage]);

  const clearMoveError = useCallback(() => {
    setState((current) => ({ ...current, moveError: null }));
  }, []);

  // Các hàm hỗ trợ mô phỏng test hoặc tương tác thủ công
  const simulateSelfDisconnect = useCallback(() => {
    return reconnectManager.handleSelfDisconnect('MANUAL_SIMULATION');
  }, [reconnectManager]);

  const simulateSelfReconnect = useCallback(() => {
    return reconnectManager.handleSelfReconnect();
  }, [reconnectManager]);

  const simulateOpponentDisconnect = useCallback((seconds = 60) => {
    return reconnectManager.handleOpponentDisconnect({ countdownSeconds: seconds });
  }, [reconnectManager]);

  const simulateOpponentReconnect = useCallback(() => {
    return reconnectManager.handleOpponentReconnect();
  }, [reconnectManager]);

  const simulateServerMatchResult = useCallback((result) => {
    return reconnectManager.handleServerMatchResult(result);
  }, [reconnectManager]);

  // FE-01: có roomCode -> gửi qua socket roomHub; không có (trận demo) -> qua WS của trận
  const sendRoomSignaling = roomSignaling.send;
  const sendSignaling = useCallback((payload) => {
    if (roomCode) return sendRoomSignaling(payload);
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }, [roomCode, sendRoomSignaling]);

  const isRoomSignalingReady = roomSignaling.isReady;
  const isSignalingReady = useCallback(() => {
    if (roomCode) return isRoomSignalingReady();
    const socket = socketRef.current;
    return Boolean(socket && socket.readyState === WebSocket.OPEN);
  }, [roomCode, isRoomSignalingReady]);

  const setSignalingHandler = useCallback((handler) => {
    signalingHandlerRef.current = handler;
  }, []);

  // FE-05: khung chat đăng ký nhận tin; trả về hàm huỷ đăng ký
  const subscribeChat = useCallback((handler) => {
    chatHandlerRef.current = handler;
    return () => {
      if (chatHandlerRef.current === handler) chatHandlerRef.current = null;
    };
  }, []);

  return {
    ...state,
    error: roomCode ? roomSignaling.error || state.error : state.error,
    socketRef,
    sendMove,
    requestLegalMoves,
    clearMoveError,
    sendSignaling,
    isSignalingReady,
    signalingError: roomCode ? roomSignaling.error : null,
    setSignalingHandler,
    subscribeChat,
    reconnectState,
    reconnectManager,
    simulateSelfDisconnect,
    simulateSelfReconnect,
    simulateOpponentDisconnect,
    simulateOpponentReconnect,
    simulateServerMatchResult,
  };
}
