import { useCallback, useEffect, useRef, useState } from 'react';
import { matchWebSocketProtocols, roomWebSocketUrl } from '../../infrastructure/api/matchApi';
import { isFatalCloseCode, nextRetryDelay } from '../../domain/network/reconnectPolicy';
import { classifyServerMessage } from '../../domain/network/signalingMessages';

// Trình duyệt không thấy được mã HTTP của lần upgrade WS thất bại (chỉ thấy close 1006).
// Quá số lần thất bại liên tiếp mà chưa từng mở được -> coi như sai quyền/mã phòng và dừng.
const MAX_UNOPENED_ATTEMPTS = 5;

/**
 * Kênh game, chat và signaling qua socket roomHub (/ws/room/:code) khi URL có `roomCode`.
 * Gói `Call*` và chat đi qua callback riêng; trạng thái phòng được chuyển cho `onRoomMessage`.
 *
 * @param {string|null} roomCode
 * @param {(message:object)=>void} onMessage
 * @param {(message:object)=>void} [onChat] FE-05: `ChatMessage` / `ChatError` của khung chat
 * @param {(message:object)=>void} [onRoomMessage] Trạng thái phòng và ván đấu
 */
export function useRoomSignaling(roomCode, onMessage, onChat, onRoomMessage) {
  const socketRef = useRef(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onChatRef = useRef(onChat);
  onChatRef.current = onChat;
  const onRoomMessageRef = useRef(onRoomMessage);
  onRoomMessageRef.current = onRoomMessage;
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!roomCode) return undefined;

    let cancelled = false;
    let retryTimeout;
    let attempt = 0;
    let unopened = 0;
    let socket;

    function connect() {
      if (cancelled) return;
      let opened = false;
      try {
        // Token đi qua Sec-WebSocket-Protocol (FE-06), không nằm trong URL
        socket = new WebSocket(roomWebSocketUrl(roomCode), matchWebSocketProtocols());
      } catch {
        setError('Không tạo được kết nối tới phòng.');
        if (typeof onRoomMessageRef.current === 'function') {
          onRoomMessageRef.current({ type: 'RoomDisconnected' });
        }
        return;
      }
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        if (cancelled) return;
        opened = true;
        attempt = 0;
        unopened = 0;
        setError(null);
      });

      socket.addEventListener('message', (event) => {
        if (cancelled) return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        const routed = classifyServerMessage(message, { movePending: false });
        if (routed.kind === 'call' && typeof onMessageRef.current === 'function') {
          onMessageRef.current(routed.message);
        } else if (routed.kind === 'chat' && typeof onChatRef.current === 'function') {
          onChatRef.current(routed.message);
        } else if (typeof onRoomMessageRef.current === 'function') {
          onRoomMessageRef.current(message);
        }
      });

      socket.addEventListener('close', (event) => {
        if (cancelled) return;
        if (socketRef.current === socket) socketRef.current = null;
        // Mất socket roomHub = server đã kết thúc cuộc gọi -> báo CallController dọn camera/mic
        if (typeof onMessageRef.current === 'function') {
          onMessageRef.current({
            type: 'CallEnded',
            reason: 'SIGNALING_LOST',
            message: 'Mất kết nối máy chủ nên cuộc gọi video đã kết thúc.',
          });
        }
        if (typeof onRoomMessageRef.current === 'function') {
          onRoomMessageRef.current({ type: 'RoomDisconnected' });
        }
        if (isFatalCloseCode(event && event.code)) {
          setError('Máy chủ từ chối kết nối tới phòng.');
          return;
        }
        if (!opened) {
          unopened += 1;
          if (unopened >= MAX_UNOPENED_ATTEMPTS) {
            setError('Không kết nối được máy chủ phòng (hãy đăng nhập và kiểm tra mã phòng).');
            return;
          }
        }
        retryTimeout = window.setTimeout(connect, nextRetryDelay(attempt));
        attempt += 1;
      });
    }

    connect();

    return () => {
      cancelled = true;
      window.clearTimeout(retryTimeout);
      if (socket) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
      socketRef.current = null;
    };
  }, [roomCode]);

  const send = useCallback((payload) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  const isReady = useCallback(() => {
    const socket = socketRef.current;
    return Boolean(socket && socket.readyState === WebSocket.OPEN);
  }, []);

  return { send, isReady, error };
}

export default useRoomSignaling;
