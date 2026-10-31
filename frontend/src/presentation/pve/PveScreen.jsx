import { useEffect, useState } from 'react';
import XiangqiBoard from '../components/board/XiangqiBoard';
import { usePveMatch } from '../../application/hooks/usePveMatch';
import { describeResult, formatClockMs } from '../../domain/pve/pveBoard';
import './PveScreen.css';

const SIDE_NAMES = { red: 'Đỏ', black: 'Đen' };

function SeatCard({ kind, color, active, children }) {
  return (
    <section className={`pve-seat pve-seat-${kind}${active ? ' is-active' : ''}`} aria-label={kind === 'bot' ? 'Máy' : 'Bạn'}>
      <span className={`pve-seat-dot ${color}`} aria-hidden="true" />
      <div className="pve-seat-text">
        <strong>{kind === 'bot' ? 'Máy' : 'Bạn'}</strong>
        <span>Quân {SIDE_NAMES[color]}</span>
      </div>
      {children}
    </section>
  );
}

/**
 * PVE-UI: màn hình chơi với máy cho `/?pveMatchId=<id>`.
 * Dùng lại XiangqiBoard; luật, nước máy đáp, đồng hồ và kết quả đều lấy từ API PvE của máy chủ.
 */
export default function PveScreen({ matchId, api }) {
  const {
    match, pieces, loading, error, moveError, clearMoveError, pending, resigning,
    isPlayerTurn, canMove, legalMoves, lastMove, lastMoves, remainingMs,
    makeMove, requestLegalMoves, resign, refresh,
  } = usePveMatch(matchId, { api });
  const [confirmingResign, setConfirmingResign] = useState(false);
  const [resultDismissed, setResultDismissed] = useState(false);

  useEffect(() => {
    document.body.classList.add('match-view');
    return () => document.body.classList.remove('match-view');
  }, []);

  useEffect(() => {
    if (!moveError) return undefined;
    const timeout = window.setTimeout(clearMoveError, 6000);
    return () => window.clearTimeout(timeout);
  }, [moveError, clearMoveError]);

  const finished = Boolean(match && match.status === 'FINISHED');
  // ván vừa kết thúc (do nước đi, xin thua hoặc server xử hết giờ) -> mở bảng kết quả
  useEffect(() => {
    if (finished) {
      setConfirmingResign(false);
      setResultDismissed(false);
    }
  }, [finished]);

  if (!matchId) {
    return (
      <main className="pve-state" role="alert">
        <strong>Mã ván đấu với máy không hợp lệ.</strong>
        <a className="pve-btn pve-btn-primary" href="/">Về sảnh chờ</a>
      </main>
    );
  }

  if (loading && !match) {
    return <main className="pve-state" role="status">Đang tải ván đấu với máy…</main>;
  }

  if (!match) {
    const unauthorized = error && error.status === 401;
    return (
      <main className="pve-state" role="alert">
        <strong>{unauthorized ? 'Bạn cần đăng nhập để chơi với máy.' : 'Không tải được ván đấu với máy.'}</strong>
        <span>{error ? error.message : 'Máy chủ chưa trả về trạng thái ván đấu.'}</span>
        <div className="pve-state-actions">
          {!unauthorized && error && error.status !== 404 && (
            <button type="button" className="pve-btn" onClick={() => refresh({ silent: false })}>Thử lại</button>
          )}
          <a className="pve-btn pve-btn-primary" href="/">Về sảnh chờ</a>
        </div>
      </main>
    );
  }

  const playerColor = match.playerColor === 'black' ? 'black' : 'red';
  const botColor = playerColor === 'red' ? 'black' : 'red';
  const result = describeResult(match);
  const botThinking = match.status === 'PLAYING' && !isPlayerTurn;
  const showResult = Boolean(result) && !resultDismissed;

  let turnText;
  if (finished) turnText = 'Ván đấu đã kết thúc';
  else if (pending && botThinking) turnText = 'Máy đang suy nghĩ…';
  else if (pending) turnText = 'Đang gửi nước đi…';
  else if (botThinking) turnText = 'Máy đang đi…';
  else turnText = 'Đến lượt bạn';

  const clockLow = remainingMs !== null && remainingMs <= 10000;

  return (
    <main className="pve-page" data-testid="pve-screen">
      <header className="pve-topbar">
        <a className="pve-back" href="/">← Về sảnh chờ</a>
        <h1>Chơi với máy</h1>
        <span className="pve-no-elo">Không tính điểm Elo</span>
      </header>

      <div className="pve-layout">
        <section className="pve-board-column" aria-label="Bàn cờ chơi với máy">
          <SeatCard kind="bot" color={botColor} active={botThinking}>
            {botThinking && <span className="pve-chip">ĐANG ĐI</span>}
          </SeatCard>

          <div className="pve-board-wrap">
            <XiangqiBoard
              pieces={pieces}
              readOnly={finished}
              playerColor={playerColor}
              interactive={canMove}
              movePending={pending}
              legalMoves={legalMoves}
              lastMove={lastMove}
              lastMoves={lastMoves}
              animateMoves
              orientation={playerColor}
              onSelectPiece={requestLegalMoves}
              onMove={makeMove}
            />
          </div>

          <SeatCard kind="player" color={playerColor} active={isPlayerTurn}>
            {isPlayerTurn && <span className="pve-chip">LƯỢT BẠN</span>}
          </SeatCard>

          {moveError && (
            <div className="pve-alert" role="alert" data-testid="pve-move-error">{moveError}</div>
          )}
        </section>

        <aside className="pve-side">
          <section className="pve-card" aria-label="Trạng thái ván đấu">
            <h2>Trạng thái</h2>
            <p className={`pve-turn${isPlayerTurn ? ' is-player' : ''}`} data-testid="pve-turn" role="status">{turnText}</p>
            <dl className="pve-facts">
              <div>
                <dt>Bạn cầm</dt>
                <dd>{SIDE_NAMES[playerColor]}</dd>
              </div>
              <div>
                <dt>Số nước đã đi</dt>
                <dd data-testid="pve-ply">{match.ply}</dd>
              </div>
              <div>
                <dt>Thời gian lượt của bạn</dt>
                <dd
                  className={`pve-clock${clockLow ? ' is-low' : ''}`}
                  data-testid="pve-clock"
                  aria-label={remainingMs === null ? 'Không tính giờ' : `Còn ${formatClockMs(remainingMs)}`}
                >
                  {finished ? '—' : remainingMs === null ? 'Máy không bị tính giờ' : formatClockMs(remainingMs)}
                </dd>
              </div>
            </dl>
            {!finished && (
              <p className="pve-hint">Quá {formatClockMs(match.turnLimitMs || 60000)} không đi, ván bị xử thua do hết giờ.</p>
            )}
          </section>

          <div className="pve-actions">
            {!finished ? (
              <button
                type="button"
                className="pve-btn pve-btn-danger"
                onClick={() => setConfirmingResign(true)}
                disabled={resigning}
                data-testid="pve-resign-btn"
              >
                🏳 Xin thua
              </button>
            ) : (
              <>
                {resultDismissed && (
                  <button type="button" className="pve-btn" onClick={() => setResultDismissed(false)}>Xem kết quả</button>
                )}
                <a className="pve-btn pve-btn-primary" href="/">Về sảnh chờ</a>
              </>
            )}
          </div>
        </aside>
      </div>

      {confirmingResign && !finished && (
        <div className="pve-modal-overlay">
          <div className="pve-modal" role="dialog" aria-modal="true" aria-labelledby="pveResignTitle" data-testid="pve-resign-confirm">
            <h2 id="pveResignTitle">Xác nhận xin thua</h2>
            <p>Bạn có chắc muốn xin thua ván này? Ván đấu sẽ kết thúc ngay với kết quả thua.</p>
            <div className="pve-modal-actions">
              <button type="button" className="pve-btn" onClick={() => setConfirmingResign(false)} disabled={resigning}>
                Tiếp tục chơi
              </button>
              <button
                type="button"
                className="pve-btn pve-btn-danger"
                disabled={resigning}
                data-testid="pve-confirm-resign"
                onClick={async () => {
                  const ok = await resign();
                  if (ok) setConfirmingResign(false);
                }}
              >
                {resigning ? 'Đang gửi…' : 'Xác nhận xin thua'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showResult && (
        <div className="pve-modal-overlay">
          <div
            className={`pve-modal pve-result pve-result-${result.kind.toLowerCase()}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pveResultTitle"
            data-testid="pve-result"
          >
            <h2 id="pveResultTitle" data-testid="pve-result-title">{result.title}</h2>
            <p>{result.subtitle}</p>
            <dl className="pve-facts">
              {result.reason && (
                <div>
                  <dt>Lý do</dt>
                  <dd data-testid="pve-result-reason">{result.reason}</dd>
                </div>
              )}
              <div>
                <dt>Bạn cầm</dt>
                <dd>{SIDE_NAMES[playerColor]}</dd>
              </div>
            </dl>
            <p className="pve-hint">Ván đấu với máy không tính điểm Elo.</p>
            <div className="pve-modal-actions">
              <button type="button" className="pve-btn" onClick={() => setResultDismissed(true)}>Xem bàn cờ</button>
              <a className="pve-btn pve-btn-primary" href="/">Về sảnh chờ</a>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
