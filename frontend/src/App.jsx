import { useEffect, useMemo, useRef, useState } from 'react';
import XiangqiBoard from './presentation/components/board/XiangqiBoard';
import ChatBox from './presentation/components/chat/ChatBox';
import { sideLabel } from './domain/chat/chatMessages';
import VideoCallOverlay from './presentation/components/video/VideoCallOverlay';
import { useMatch } from './application/hooks/useMatch';
import { useWebRtcCall } from './application/hooks/useWebRtcCall';
import { parseRoomCodeParam } from './domain/network/roomCodeParam';
import { BoardSyncManager } from './domain/game/boardSyncManager';
import { moveSoundPlayer } from './infrastructure/sound/moveSound';
import './styles.css';

function formatClock(seconds = 0) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function PlayerCard({ player, color, active, time, isPaused = false }) {
  const isRed = color === 'red';
  const clockIsLow = time <= 30 && !isPaused;

  return (
    <section className={`player-card ${active ? 'is-active' : ''} ${isPaused ? 'player-card-paused' : ''}`}>
      <div className={`player-avatar ${isRed ? 'red' : 'black'}`}>
        {player.name.slice(0, 1)}
      </div>
      <div className="player-details">
        <span className="player-side">
          <span className={`side-dot ${isRed ? 'red' : 'black'}`} />
          {isRed ? 'QUÂN ĐỎ' : 'QUÂN ĐEN'}
          {active && (
            <span className={`turn-chip ${isPaused ? 'turn-chip-paused' : ''}`}>
              {isPaused ? 'TẠM DỪNG' : 'ĐANG ĐI'}
            </span>
          )}
        </span>
        <strong>{player.name}</strong>
        <span className="player-rating">{player.rating} ELO</span>
      </div>
      <div
        className={`player-clock ${active ? 'clock-active' : ''} ${clockIsLow ? 'clock-low' : ''} ${isPaused ? 'clock-paused' : ''}`}
        aria-label={`Thời gian ${formatClock(time)}`}
      >
        <span className="clock-icon" aria-hidden="true">{isPaused ? '⏸' : '◷'}</span>
        <span className="clock-digits">{formatClock(time)}</span>
        {isPaused && <span className="clock-pause-tag">TẠM DỪNG</span>}
      </div>
    </section>
  );
}

const CAPTURED_PIECE_NAMES = {
  general: 'Tướng',
  advisor: 'Sĩ',
  elephant: 'Tượng',
  horse: 'Mã',
  chariot: 'Xe',
  cannon: 'Pháo',
  soldier: 'Chốt',
};

const CAPTURED_PIECE_MARKS = {
  general: 'T',
  advisor: 'S',
  elephant: 'T',
  horse: 'M',
  chariot: 'X',
  cannon: 'P',
  soldier: 'C',
};

function CapturedTray({ color, pieces }) {
  return (
    <div className={`captured-tray captured-tray-${color}`} aria-label={`Quân ${color === 'red' ? 'Đỏ' : 'Đen'} đã bị bắt`}>
      <span className="captured-tray-label">{color === 'red' ? 'ĐỎ MẤT' : 'ĐEN MẤT'}</span>
      <div className="captured-tray-pieces">
        {pieces.length ? pieces.map((piece, index) => (
          <span
            key={`${piece.id}-${index}`}
            className={`captured-token ${piece.color}`}
            title={`${CAPTURED_PIECE_NAMES[piece.type]} ${color === 'red' ? 'Đỏ' : 'Đen'} đã bị bắt`}
            aria-label={`${CAPTURED_PIECE_NAMES[piece.type]} đã bị bắt`}
          >
            {CAPTURED_PIECE_MARKS[piece.type]}
          </span>
        )) : <span className="captured-tray-empty">Chưa mất quân</span>}
      </div>
      <strong>{pieces.length}</strong>
    </div>
  );
}

function App() {
  const searchParams = new URLSearchParams(window.location.search);
  const matchId = searchParams.get('matchId');
  // FE-01: có roomCode hợp lệ -> signaling cuộc gọi đi qua roomHub; không có (demo) -> WS của trận
  const roomCode = parseRoomCodeParam(searchParams.get('roomCode'));
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [perspectiveEnabled, setPerspectiveEnabled] = useState(false);
  const [captureEffect, setCaptureEffect] = useState(null);
  const previousMoveRef = useRef(undefined);
  const previousBoardRef = useRef(null);
  const captureEffectTimeoutRef = useRef(null);
  const {
    match,
    loading,
    error,
    color,
    readOnly,
    connected,
    movePending,
    moveError,
    sendMove,
    legalMoves,
    requestLegalMoves,
    clearMoveError,
    reconnectState,
    simulateSelfDisconnect,
    simulateSelfReconnect,
    simulateOpponentDisconnect,
    simulateOpponentReconnect,
    simulateServerMatchResult,
    sendSignaling,
    isSignalingReady,
    signalingError,
    setSignalingHandler,
    subscribeChat,
  } = useMatch(matchId, { roomCode });

  const currentUserName = color === 'red' ? match?.players?.red?.name : color === 'black' ? match?.players?.black?.name : 'Khán Giả';
  const opponentUserName = color === 'red' ? match?.players?.black?.name : color === 'black' ? match?.players?.red?.name : 'Đối thủ';

  const {
    callStatus,
    incomingCall,
    remoteStream,
    localStream,
    isMicMuted,
    isCamOff,
    isRemoteCamOff,
    error: callError,
    notice: callNotice,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMic,
    toggleCam,
    handleSignalingMessage,
  } = useWebRtcCall({
    sendSignaling,
    isSignalingReady,
    isSpectator: readOnly,
    userName: currentUserName || 'Bạn',
    opponentName: opponentUserName || 'Đối thủ',
  });

  useEffect(() => {
    if (typeof setSignalingHandler === 'function') {
      setSignalingHandler(handleSignalingMessage);
    }
  }, [setSignalingHandler, handleSignalingMessage]);

  // FE-08: khay quân bị bắt tính từ bàn cờ hiện tại (đúng cả khi tải lại trang / kết nối lại),
  // không cộng dồn theo từng lastMove như trước.
  const capturedPieces = useMemo(
    () => (match?.board ? BoardSyncManager.deriveCapturedPieces(match.board) : { red: [], black: [] }),
    [match?.board],
  );

  // FE-08: mở khóa AudioContext dùng chung ở thao tác đầu tiên của người dùng
  useEffect(() => {
    const unlock = () => moveSoundPlayer.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    document.body.classList.toggle('match-view', Boolean(matchId || roomCode));
    return () => document.body.classList.remove('match-view');
  }, [matchId, roomCode]);

  const lastMove = match?.lastMove;
  const lastMoveKey = lastMove
    ? `${lastMove.color}:${lastMove.from}:${lastMove.to}:${Boolean(lastMove.captured)}`
    : null;

  useEffect(() => {
    if (!match) return;
    if (previousMoveRef.current === undefined) {
      previousMoveRef.current = lastMoveKey;
      previousBoardRef.current = match.board;
      return;
    }
    if (lastMoveKey && previousMoveRef.current !== lastMoveKey) {
      if (soundEnabled) moveSoundPlayer.play(Boolean(lastMove.captured));
      if (lastMove.captured) {
        const capturedPiece = previousBoardRef.current?.find(
          (piece) => piece.position === lastMove.to && piece.color !== lastMove.color,
        );
        setCaptureEffect({ key: lastMoveKey, position: lastMove.to, capturedPiece });
        window.clearTimeout(captureEffectTimeoutRef.current);
        captureEffectTimeoutRef.current = window.setTimeout(() => {
          setCaptureEffect(null);
        }, 750);
      }
    }
    previousMoveRef.current = lastMoveKey;
    previousBoardRef.current = match.board;
  }, [lastMove, lastMoveKey, match, soundEnabled]);

  useEffect(() => () => window.clearTimeout(captureEffectTimeoutRef.current), []);

  useEffect(() => {
    if (!moveError) return undefined;
    const timeout = window.setTimeout(clearMoveError, 4000);
    return () => window.clearTimeout(timeout);
  }, [moveError, clearMoveError]);

  if (!matchId && !roomCode) {
    return null;
  }

  if (loading && !match && !error) {
    return <main className="request-state" role="status">Đang tải trạng thái trận đấu…</main>;
  }

  if (!match) {
    return (
      <main className="request-state request-error" role="alert">
        <strong>{roomCode ? `Không thể kết nối phòng ${roomCode}` : `Không tải được trận đấu ${matchId}`}</strong>
        <span>{error || 'Máy chủ chưa trả về trạng thái Match.'}</span>
        <span>Hãy kiểm tra backend đang chạy tại địa chỉ trong `VITE_API_URL`.</span>
      </main>
    );
  }

  const isStarting = match.status === 'starting';
  const countdown = isStarting ? match.countdownSeconds : null;
  const currentTurn = isStarting ? null : match.currentTurn;
  const activePlayer = currentTurn === 'red' || currentTurn === 'black' ? currentTurn : null;
  const playerTurnHint = isStarting
    ? 'Chờ trận bắt đầu để chọn quân.'
    : currentTurn !== color
      ? `Đang đến lượt quân ${currentTurn === 'red' ? 'Đỏ' : 'Đen'}. Hãy đợi đối thủ đi xong.`
      : 'Chọn một quân để xem các vị trí có thể đi.';
  const checkedColor = match.checkedColor ||
    (match.check === true || match.inCheck === true ? match.currentTurn : null);
  const checkedGeneral = checkedColor
    ? match.board.find((piece) => piece.type === 'general' && piece.color === checkedColor)
    : null;

  return (
    <main className="game-page">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Cờ Tướng Online - Trang chủ">
          <span className="brand-mark" aria-hidden="true">棋</span>
          <span className="brand-name">Kỳ <b>Thủ</b></span>
        </a>
        <div className="topbar-divider" />
        <div className="room-label">
          <span className="breadcrumb-muted">Phòng đấu</span>
          <span className="breadcrumb-chevron">/</span>
          <strong>{match.roomName}</strong>
        </div>
        <div className="topbar-right">
          <span className="demo-indicator"><i /> BẢN XEM TRƯỚC</span>
          <span className="viewer-pill"><span aria-hidden="true">◉</span> {readOnly ? 'Khán giả' : `Quân ${color === 'red' ? 'Đỏ' : 'Đen'}`}</span>
          <details className="match-settings">
            <summary className="icon-button" aria-label="Cài đặt trận đấu" title="Cài đặt trận đấu">•••</summary>
            <div className="match-settings-panel">
              <label>
                <input
                  type="checkbox"
                  checked={soundEnabled}
                  onChange={(event) => setSoundEnabled(event.target.checked)}
                />
                <span>
                  <strong>Âm thanh</strong>
                  <small>{soundEnabled ? 'Bật âm đi và ăn quân' : 'Đã tắt âm thanh'}</small>
                </span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={perspectiveEnabled}
                  onChange={(event) => setPerspectiveEnabled(event.target.checked)}
                />
                <span>
                  <strong>Góc nhìn phối cảnh</strong>
                  <small>{perspectiveEnabled ? 'Đang nghiêng nhẹ bàn cờ' : 'Đang nhìn thẳng'}</small>
                </span>
              </label>

              {/* FE-06: công cụ giả lập chỉ có ở bản dev, không lọt vào bản build production */}
              {import.meta.env.DEV && (
                <div className="simulation-tools-group">
                  <span className="simulation-title">Kiểm thử mạng (COT-601)</span>
                  <button
                    type="button"
                    className="btn-sim"
                    onClick={() => {
                      if (reconnectState.selfDisconnected) simulateSelfReconnect();
                      else simulateSelfDisconnect();
                    }}
                  >
                    {reconnectState.selfDisconnected ? '✓ Kết nối lại bản thân' : '⚡ Giả lập mất mạng bản thân'}
                  </button>
                  <button
                    type="button"
                    className="btn-sim"
                    onClick={() => {
                      if (reconnectState.opponentDisconnected) simulateOpponentReconnect();
                      else simulateOpponentDisconnect(60);
                    }}
                  >
                    {reconnectState.opponentDisconnected ? '✓ Đối thủ kết nối lại' : '⚠️ Giả lập đối thủ mất mạng (60s)'}
                  </button>
                  <button
                    type="button"
                    className="btn-sim"
                    onClick={() => {
                      simulateServerMatchResult({
                        winner: color || 'red',
                        winnerColor: color || 'red',
                        reason: 'DISCONNECT_TIMEOUT',
                      });
                    }}
                  >
                    🏆 Máy chủ chốt kết quả (Timeout)
                  </button>
                </div>
              )}
            </div>
          </details>
        </div>
      </header>

      <div className="game-layout">
        <section className="match-column" aria-label="Trận đấu cờ tướng">
          <div className="match-heading">
            <div>
              <div className="eyebrow">TRẬN ĐẤU · {match.matchCode}</div>
              <h1>{match.title}</h1>
              <p>Trạng thái trận đấu được cập nhật từ máy chủ</p>
            </div>
            <div className={`match-status ${isStarting ? 'status-starting' : ''}`}>
              <span className="status-dot" />
              {isStarting ? 'SẮP BẮT ĐẦU' : match.status === 'active' ? 'ĐANG DIỄN RA' : match.status}
            </div>
          </div>

          {/* COT-601 AC 1: Banner cảnh báo Đối thủ mất kết nối kèm đếm ngược 60s */}
          {reconnectState.banner?.visible && (
            <div
              className={`opponent-disconnect-banner ${reconnectState.banner.type === 'WAITING_SERVER' ? 'banner-waiting-server' : ''}`}
              role="alert"
              aria-live="assertive"
            >
              <div className="banner-left-content">
                <span className="banner-pulse-icon" aria-hidden="true">
                  {reconnectState.banner.type === 'WAITING_SERVER' ? '⏳' : '⚠️'}
                </span>
                <div className="banner-texts">
                  <div className="banner-title-line">
                    <strong>{reconnectState.banner.title}</strong>
                    <span className="banner-status-tag">
                      {reconnectState.banner.type === 'WAITING_SERVER' ? 'Chờ máy chủ' : 'Tạm dừng ván'}
                    </span>
                  </div>
                  <p className="banner-subtext">{reconnectState.banner.message}</p>
                </div>
              </div>
              {reconnectState.banner.type === 'OPPONENT_DISCONNECTED' && (
                <div className="banner-timer-badge" title="Đồng hồ đếm ngược chờ kết nối lại">
                  <span className="timer-badge-label">HẠN CHỜ</span>
                  <div className="timer-circle-box">
                    <span className="timer-number">{reconnectState.banner.countdown}</span>
                    <span className="timer-sec">s</span>
                  </div>
                </div>
              )}
              {reconnectState.banner.type === 'WAITING_SERVER' && (
                <div className="banner-waiting-badge">
                  <span className="server-spinner" />
                  <span>Xử lý kết quả</span>
                </div>
              )}
            </div>
          )}

          {checkedColor && (
            <div className={`check-alert check-alert-${checkedColor}`} role="alert" aria-live="assertive">
              <span aria-hidden="true">!</span>
              <strong>Chiếu Tướng!</strong>
              <span>Tướng {checkedColor === 'red' ? 'Đỏ' : 'Đen'} đang bị chiếu.</span>
            </div>
          )}

          <div className={`board-shell ${perspectiveEnabled ? 'perspective-enabled' : ''}`}>
            {/* COT-601 AC 1: Overlay thông báo khi chính người dùng mất kết nối */}
            {reconnectState.overlay?.visible && (
              <div className="reconnecting-overlay" role="alert" aria-live="assertive">
                <div className="reconnecting-card">
                  <div className="reconnecting-radar">
                    <span className="radar-circle circle-1" />
                    <span className="radar-circle circle-2" />
                    <span className="radar-circle circle-3" />
                    <span className="radar-icon" aria-hidden="true">📡</span>
                  </div>
                  <h3 className="reconnecting-title">{reconnectState.overlay.title}</h3>
                  <p className="reconnecting-desc">{reconnectState.overlay.message}</p>
                  <div className="reconnecting-badge">
                    <span className="lock-icon" aria-hidden="true">🔒</span>
                    <span>Toàn bộ thao tác trên bàn cờ đã được tạm khóa</span>
                  </div>
                  <div className="reconnecting-progress">
                    <div className="progress-bar-glow" />
                  </div>
                </div>
              </div>
            )}

            <PlayerCard
              player={match.players.black}
              color="black"
              active={activePlayer === 'black'}
              time={match.clocks.black}
              isPaused={reconnectState.normalClockPaused}
            />
            <XiangqiBoard
              pieces={match.board}
              countdown={countdown}
              readOnly={readOnly}
              playerColor={color}
              interactive={
                !readOnly &&
                !isStarting &&
                currentTurn === color &&
                !movePending &&
                reconnectState.canMove
              }
              movePending={movePending}
              legalMoves={legalMoves}
              orientation={color === 'black' ? 'black' : 'red'}
              checkedColor={checkedGeneral ? checkedColor : null}
              lastMove={lastMove}
              animateMoves={Boolean(roomCode)}
              captureEffect={captureEffect}
              onSelectPiece={requestLegalMoves}
              onMove={sendMove}
            />
            <PlayerCard
              player={match.players.red}
              color="red"
              active={activePlayer === 'red'}
              time={match.clocks.red}
              isPaused={reconnectState.normalClockPaused}
            />
            <div className="captured-trays" aria-live="polite">
              <CapturedTray color="black" pieces={capturedPieces.black} />
              <CapturedTray color="red" pieces={capturedPieces.red} />
            </div>
          </div>

          {/* COT-601 AC 3: Modal kết quả ván đấu do máy chủ trả về */}
          {reconnectState.serverResult && (
            <div className="match-result-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="resultModalTitle">
              <div className="match-result-card">
                <div className="result-header">
                  <span className="result-trophy-icon" aria-hidden="true">🏆</span>
                  <h3 id="resultModalTitle">KẾT QUẢ VÁN ĐẤU</h3>
                  <span className="server-confirmed-badge">✓ Xác nhận từ Máy Chủ</span>
                </div>
                <div className="result-body">
                  <div className="result-winner-box">
                    <strong className="result-message-text">{reconnectState.serverResult.message}</strong>
                  </div>
                  <p className="result-rule-note">
                    Kết quả đã được máy chủ cập nhật chính thức vào hệ thống giải đấu theo quy định thời gian chờ kết nối lại (COT-601).
                  </p>
                </div>
                <div className="result-actions">
                  <a href="/" className="btn btn-primary btn-large">Về Sảnh Chờ / Danh Sách Phòng</a>
                </div>
              </div>
            </div>
          )}

          {readOnly ? (
            <div className="spectator-note">
              <span className="spectator-icon" aria-hidden="true">◉</span>
              <span><strong>Bạn đang ở chế độ khán giả</strong><br />Bạn có thể xem toàn bộ bàn cờ nhưng không thể điều khiển quân.</span>
              <span className="spectator-lock" aria-hidden="true">⌑</span>
            </div>
          ) : (
            <div className="spectator-note player-instructions">
              <span className="spectator-icon" aria-hidden="true">♟</span>
              <span><strong>Bạn đang chơi bên {color === 'red' ? 'Đỏ' : 'Đen'}</strong><br />{playerTurnHint}</span>
              <span className="spectator-lock" aria-hidden="true">
                {reconnectState.selfDisconnected
                  ? 'Mạng chập chờn — đang tạm khóa'
                  : reconnectState.opponentDisconnected
                    ? 'Đối thủ mất kết nối — tạm dừng'
                    : movePending
                      ? 'Đang gửi nước đi…'
                      : currentTurn === color
                        ? 'Nhấn quân của bạn để chọn nước đi'
                        : 'Chưa tới lượt bạn'}
              </span>
            </div>
          )}
          {moveError && <div className="move-alert" role="alert">{moveError}</div>}
        </section>

        <aside className="info-column">
          {/* COT-629: Cuộc gọi Video WebRTC giữa hai người chơi */}
          <VideoCallOverlay
            callStatus={callStatus}
            incomingCall={incomingCall}
            remoteStream={remoteStream}
            localStream={localStream}
            isMicMuted={isMicMuted}
            isCamOff={isCamOff}
            isRemoteCamOff={isRemoteCamOff}
            isSpectator={readOnly}
            error={callError || signalingError}
            notice={callNotice}
            userName={currentUserName || 'Bạn'}
            opponentName={opponentUserName || 'Đối thủ'}
            onStartCall={startCall}
            onAccept={acceptCall}
            onReject={rejectCall}
            onEnd={endCall}
            onToggleMic={toggleMic}
            onToggleCam={toggleCam}
          />

          <section className="info-card turn-card">
            <div className="card-heading">
              <span className="heading-icon turn-icon" aria-hidden="true">↗</span>
              <h2>Lượt hiện tại</h2>
            </div>
            <div className={`turn-banner ${currentTurn === 'red' ? 'turn-red' : currentTurn === 'black' ? 'turn-black' : ''}`}>
              <span className={`turn-piece ${currentTurn === 'black' ? 'piece-black' : ''}`}>
                {currentTurn === 'black' ? '將' : '帥'}
              </span>
              <div>
                <strong>
                  {reconnectState.normalClockPaused
                    ? 'Tạm dừng ván đấu'
                    : isStarting
                      ? 'Chuẩn bị khai cuộc'
                      : currentTurn === 'red'
                        ? 'Đỏ đi trước'
                        : 'Đen đang đi'}
                </strong>
                <span>
                  {reconnectState.normalClockPaused
                    ? 'Chờ kết nối lại'
                    : isStarting
                      ? 'Hai bên đã sẵn sàng'
                      : `Lượt ${match.moveNumber}`}
                </span>
              </div>
              <span className={`turn-pulse ${reconnectState.normalClockPaused ? 'pulse-paused' : ''}`} />
            </div>
            <div className="turn-fact">
              <span>Bên đi trước</span><strong><i className="fact-red-dot" /> Đỏ</strong>
            </div>
            <div className="turn-fact">
              <span>Thời gian mỗi bên</span><strong>{formatClock(match.timeControlSeconds)}</strong>
            </div>
            {reconnectState.normalClockPaused && (
              <div className="turn-fact fact-warning">
                <span>Trạng thái</span><strong className="text-warning">Đang dừng chờ kết nối</strong>
              </div>
            )}
          </section>

          <section className="info-card match-info-card">
            <div className="card-heading">
              <span className="heading-icon detail-icon" aria-hidden="true">▤</span>
              <h2>Thông tin trận</h2>
            </div>
            <dl className="match-details">
              <div><dt>Chế độ</dt><dd><span className="mode-icon">♟</span> Đấu xếp hạng</dd></div>
              <div><dt>Thời gian</dt><dd>{formatClock(match.timeControlSeconds)} / bên</dd></div>
              <div><dt>Khán giả</dt><dd><span className="viewer-count">◉</span> {match.viewerCount} người</dd></div>
              <div><dt>Trạng thái</dt><dd><span className="detail-live-dot" /> {isStarting ? 'Đếm ngược' : 'Đỏ đi trước'}</dd></div>
            </dl>
          </section>

          <section className="info-card guide-card">
            <div className="card-heading">
              <span className="heading-icon guide-icon" aria-hidden="true">✦</span>
              <h2>Luật bàn cờ</h2>
            </div>
            <p>Bàn cờ gồm <strong>9 cột × 10 hàng</strong>. Hai bên bắt đầu với 16 quân và Đỏ luôn đi trước.</p>
            <div className="river-legend"><span /> <span>Sông phân cách hai chiến tuyến</span></div>
          </section>

          <div className={`connection-state ${reconnectState.selfDisconnected || error ? 'connection-error' : ''}`}>
            <span className={`connection-dot ${reconnectState.selfDisconnected || error ? 'error-dot' : ''}`} />
            {reconnectState.selfDisconnected
              ? 'Mạng chập chờn — đang kết nối lại...'
              : error
                ? 'Mất kết nối — đang thử lại'
                : connected
                  ? 'Đã kết nối thời gian thực'
                  : 'Đang kết nối thời gian thực'}
          </div>
        </aside>
      </div>
      <footer className="page-footer">
        <span>♟ &nbsp; KỲ THỦ ONLINE</span>
        <span>CHÚC CÁC KỲ THỦ CÓ MỘT VÁN CỜ HAY</span>
      </footer>
      {/* COT-630: Khung chat text thời gian thực giữa hai người chơi trong phòng */}
      <ChatBox
        roomId={match.matchCode || matchId}
        currentUser={{
          // FE-05: tên theo phe (Đỏ/Đen/Khán giả); server sẽ trả tên thật khi ack
          id: color === 'red' ? 'player_red' : color === 'black' ? 'player_black' : 'spectator_user',
          name: sideLabel(color),
          avatar: color === 'red' ? '帥' : color === 'black' ? '將' : '観',
        }}
        role={readOnly ? 'SPECTATOR' : color === 'red' ? 'HOST' : 'PLAYER'}
        readOnly={readOnly}
        onSendMessage={(msg) => sendSignaling({ type: 'chat:send', text: msg.text, clientId: msg.clientId })}
        subscribeChat={subscribeChat}
      />
    </main>
  );
}

export default App;
