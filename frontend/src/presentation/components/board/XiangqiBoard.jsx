import { useEffect, useMemo, useRef, useState } from 'react';
import './XiangqiBoard.css';

const BOARD = {
  left: 54,
  right: 846,
  top: 48,
  bottom: 952
};

const FILES = 'abcdefghi';
const PIECE_LABELS = {
  general: 'Tướng',
  advisor: 'Sĩ',
  elephant: 'Tượng',
  horse: 'Mã',
  chariot: 'Xe',
  cannon: 'Pháo',
  soldier: 'Chốt'
};

function point(fileIndex, rank, orientation = 'red') {
  const isBlackView = orientation === 'black';
  return {
    x: isBlackView
      ? BOARD.right - (BOARD.right - BOARD.left) * (fileIndex / 8)
      : BOARD.left + (BOARD.right - BOARD.left) * (fileIndex / 8),
    y: isBlackView
      ? BOARD.top + (BOARD.bottom - BOARD.top) * (rank / 9)
      : BOARD.bottom - (BOARD.bottom - BOARD.top) * (rank / 9)
  };
}

function BoardGrid() {
  const horizontalLines = Array.from({ length: 10 }, (_, rank) => {
    const { y } = point(0, rank);
    return <line key={`rank-${rank}`} x1={BOARD.left} y1={y} x2={BOARD.right} y2={y} />;
  });

  const verticalLines = Array.from({ length: 9 }, (_, fileIndex) => {
    const { x } = point(fileIndex, 0);
    const segments = fileIndex === 0 || fileIndex === 8
      ? [[BOARD.top, BOARD.bottom]]
      : [[BOARD.top, point(fileIndex, 5).y], [point(fileIndex, 4).y, BOARD.bottom]];

    return segments.map(([y1, y2], segmentIndex) => (
      <line key={`file-${fileIndex}-${segmentIndex}`} x1={x} y1={y1} x2={x} y2={y2} />
    ));
  });

  const topLeft = point(3, 9);
  const topRight = point(5, 7);
  const topFarRight = point(5, 9);
  const topOpposite = point(3, 7);
  const bottomLeft = point(3, 0);
  const bottomRight = point(5, 2);
  const bottomFarRight = point(5, 0);
  const bottomOpposite = point(3, 2);

  return (
    <g className="board-lines">
      {horizontalLines}
      {verticalLines}
      <line x1={topLeft.x} y1={topLeft.y} x2={topRight.x} y2={topRight.y} />
      <line x1={topFarRight.x} y1={topFarRight.y} x2={topOpposite.x} y2={topOpposite.y} />
      <line x1={bottomLeft.x} y1={bottomLeft.y} x2={bottomRight.x} y2={bottomRight.y} />
      <line x1={bottomFarRight.x} y1={bottomFarRight.y} x2={bottomOpposite.x} y2={bottomOpposite.y} />
    </g>
  );
}

function BoardDetails() {
  const markedPoints = [
    [1, 2], [7, 2], [1, 7], [7, 7],
    [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
    [0, 6], [2, 6], [4, 6], [6, 6], [8, 6]
  ];

  return (
    <g className="board-details" aria-hidden="true">
      {markedPoints.map(([fileIndex, rank]) => {
        const { x, y } = point(fileIndex, rank);
        const outer = 24;
        const arm = 18;
        const leftMark = fileIndex > 0;
        const rightMark = fileIndex < 8;

        return (
          <g
            key={`mark-${fileIndex}-${rank}`}
            className="board-position-mark"
            data-mark-position={`${FILES[fileIndex]}${rank}`}
          >
            {leftMark && (
              <>
                <path d={`M ${x - outer} ${y - outer} h ${arm} M ${x - outer} ${y - outer} v ${arm}`} />
                <path d={`M ${x - outer} ${y + outer} h ${arm} M ${x - outer} ${y + outer} v -${arm}`} />
              </>
            )}
            {rightMark && (
              <>
                <path d={`M ${x + outer} ${y - outer} h -${arm} M ${x + outer} ${y - outer} v ${arm}`} />
                <path d={`M ${x + outer} ${y + outer} h -${arm} M ${x + outer} ${y + outer} v -${arm}`} />
              </>
            )}
          </g>
        );
      })}
      <g className="board-corner-ornaments">
        <path d="M 37 45 v -10 h 10 M 863 45 v -10 h -10 M 37 955 v 10 h 10 M 863 955 v 10 h -10" />
        <circle cx="37" cy="35" r="2.5" />
        <circle cx="863" cy="35" r="2.5" />
        <circle cx="37" cy="965" r="2.5" />
        <circle cx="863" cy="965" r="2.5" />
      </g>
    </g>
  );
}

function Piece({ piece, orientation, selected, interactive }) {
  const validPosition = typeof piece?.position === 'string' && /^[a-i][0-9]$/i.test(piece.position);
  const fileIndex = validPosition ? FILES.indexOf(piece.position[0].toLowerCase()) : 0;
  const rank = validPosition ? Number(piece.position.slice(1)) : 0;
  const targetPoint = point(fileIndex, rank, orientation);
  const [renderPoint, setRenderPoint] = useState(targetPoint);
  const renderPointRef = useRef(targetPoint);
  const orientationRef = useRef(orientation);
  const label = piece ? PIECE_LABELS[piece.type] : null;

  if (!validPosition || fileIndex < 0 || rank < 0 || rank > 9 || !label) {
    return null;
  }

  useEffect(() => {
    const nextPoint = point(fileIndex, rank, orientation);
    if (orientationRef.current !== orientation) {
      orientationRef.current = orientation;
      renderPointRef.current = nextPoint;
      setRenderPoint(nextPoint);
      return undefined;
    }

    const startPoint = renderPointRef.current;
    if (startPoint.x === nextPoint.x && startPoint.y === nextPoint.y) return undefined;

    const duration = 520;
    let frameId;
    let startTime;
    const animate = (timestamp) => {
      if (startTime === undefined) startTime = timestamp;
      const progress = Math.min(1, (timestamp - startTime) / duration);
      const eased = 1 - ((1 - progress) ** 3);
      const currentPoint = {
        x: startPoint.x + ((nextPoint.x - startPoint.x) * eased),
        y: startPoint.y + ((nextPoint.y - startPoint.y) * eased),
      };
      renderPointRef.current = currentPoint;
      setRenderPoint(currentPoint);
      if (progress < 1) frameId = window.requestAnimationFrame(animate);
    };

    frameId = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frameId);
  }, [fileIndex, orientation, rank]);

  const { x, y } = renderPoint;

  return (
    <g
      className={`xiangqi-piece ${piece.color}${selected ? ' is-selected' : ''}${interactive ? ' is-interactive' : ''}`}
      transform={`translate(${x} ${y})`}
      aria-label={`${piece.color === 'red' ? 'Đỏ' : 'Đen'} ${label} tại ${piece.position}`}
      aria-pressed={selected}
      data-position={piece.position}
      data-piece-id={piece.id}
      role={interactive ? 'button' : undefined}
    >
      <circle className="piece-shadow" cx="1.5" cy="4" r="35" />
      <circle className="piece-edge" r="33" />
      <circle className="piece-side-rim" r="31.5" />
      <circle className="piece-bevel" r="30.5" />
      <circle className="piece-face" cy="-1" r="29" />
      <circle className="piece-inner-ring" cy="-1" r="23.5" />
      <path className="piece-glint" d="M -17 -20 A 27 27 0 0 1 17 -20" />
      <ellipse className="piece-reflection" cx="-10" cy="-17" rx="8" ry="3.2" transform="rotate(-28 -10 -17)" />
      <text
        className={`piece-label piece-label-${piece.type}`}
        textAnchor="middle"
        dominantBaseline="central"
        textLength={label.length > 3 ? 43 : undefined}
        lengthAdjust="spacingAndGlyphs"
      >
        {label}
      </text>
    </g>
  );
}

function toSvgPoint(svg, clientX, clientY) {
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  return point.matrixTransform(matrix.inverse());
}

function getPositionAt(svg, clientX, clientY, orientation) {
  const local = toSvgPoint(svg, clientX, clientY);
  if (!local) return null;

  const fileStep = (BOARD.right - BOARD.left) / 8;
  const rankStep = (BOARD.bottom - BOARD.top) / 9;
  const displayFile = Math.round((local.x - BOARD.left) / fileStep);
  const displayRank = orientation === 'black'
    ? Math.round((local.y - BOARD.top) / rankStep)
    : Math.round((BOARD.bottom - local.y) / rankStep);
  const target = point(orientation === 'black' ? 8 - displayFile : displayFile, displayRank, orientation);
  if (
    displayFile < 0 || displayFile > 8 || displayRank < 0 || displayRank > 9 ||
    Math.hypot(local.x - target.x, local.y - target.y) > 46
  ) {
    return null;
  }

  return `${FILES[orientation === 'black' ? 8 - displayFile : displayFile]}${displayRank}`;
}

function getPositionPoint(position, orientation) {
  if (typeof position !== 'string' || !/^[a-i][0-9]$/i.test(position)) return null;
  return point(FILES.indexOf(position[0].toLowerCase()), Number(position.slice(1)), orientation);
}

function getCornerPath({ x, y }, halfSize, cornerSize) {
  const left = x - halfSize;
  const right = x + halfSize;
  const top = y - halfSize;
  const bottom = y + halfSize;
  return [
    `M ${left + cornerSize} ${top} H ${left} V ${top + cornerSize}`,
    `M ${right - cornerSize} ${top} H ${right} V ${top + cornerSize}`,
    `M ${left} ${bottom - cornerSize} V ${bottom} H ${left + cornerSize}`,
    `M ${right} ${bottom - cornerSize} V ${bottom} H ${right - cornerSize}`,
  ].join(' ');
}

export default function XiangqiBoard({
  pieces,
  countdown = null,
  readOnly = true,
  playerColor = null,
  interactive = false,
  movePending = false,
  orientation = 'red',
  checkedColor = null,
  legalMoves = null,
  lastMove = null,
  lastMoves = null,
  animateMoves = false,
  captureEffect = null,
  onSelectPiece = () => {},
  onMove = () => {},
}) {
  const [selectedPieceId, setSelectedPieceId] = useState(null);
  const pieceIdentityRef = useRef(new Map());
  const selectedPiece = pieces.find((piece) => piece.id === selectedPieceId);
  const checkedGeneral = checkedColor
    ? pieces.find((piece) => piece.type === 'general' && piece.color === checkedColor)
    : null;
  const checkedPosition = checkedGeneral && /^[a-i][0-9]$/i.test(checkedGeneral.position)
    ? checkedGeneral.position
    : null;
  const checkedFile = checkedPosition ? FILES.indexOf(checkedPosition[0].toLowerCase()) : -1;
  const checkedRank = checkedPosition ? Number(checkedPosition.slice(1)) : -1;
  const checkedPoint = checkedFile >= 0 && checkedRank >= 0 && checkedRank <= 9
    ? point(checkedFile, checkedRank, orientation)
    : null;
  const captureFile = captureEffect ? FILES.indexOf(captureEffect.position?.[0]?.toLowerCase()) : -1;
  const captureRank = captureEffect ? Number(captureEffect.position?.slice(1)) : -1;
  const capturePoint = captureFile >= 0 && captureRank >= 0 && captureRank <= 9
    ? point(captureFile, captureRank, orientation)
    : null;
  const coordinates = orientation === 'black' ? [...FILES].reverse() : [...FILES];
  const boardPositionSignature = pieces.map((piece) => `${piece.id}:${piece.position}`).join('|');
  const pieceRenderIds = useMemo(() => {
    const identities = new Map(pieceIdentityRef.current);
    const moves = Array.isArray(lastMoves) ? lastMoves : lastMove ? [lastMove] : [];
    if (animateMoves) {
      moves.forEach((move) => {
        const from = typeof move.from === 'string'
          ? move.from
          : move.from && Number.isInteger(move.from.row) && Number.isInteger(move.from.col)
            ? `${FILES[move.from.col]}${move.from.row}`
            : null;
        const to = typeof move.to === 'string'
          ? move.to
          : move.to && Number.isInteger(move.to.row) && Number.isInteger(move.to.col)
            ? `${FILES[move.to.col]}${move.to.row}`
            : null;
        const movingPiece = pieces.find((piece) => piece.position === from);
        const identity = identities.get(from) ||
          (movingPiece ? { id: movingPiece.id, color: movingPiece.color, type: movingPiece.type } : null);
        if (!from || !to || !identity) return;
        identities.delete(from);
        identities.delete(to);
        identities.set(to, identity);
      });
    } else {
      identities.clear();
    }

    const nextIdentities = new Map();
    const renderIds = new Map();
    pieces.forEach((piece) => {
      const currentIdentity = identities.get(piece.position);
      const identity = currentIdentity?.color === piece.color && currentIdentity?.type === piece.type
        ? currentIdentity
        : { id: piece.id, color: piece.color, type: piece.type };
      nextIdentities.set(piece.position, identity);
      renderIds.set(piece.position, identity.id);
    });
    pieceIdentityRef.current = nextIdentities;
    return renderIds;
  }, [animateMoves, lastMove, lastMoves, pieces]);
  const legalDestinations = interactive && selectedPiece && legalMoves?.from === selectedPiece.position
    ? legalMoves.destinations
    : [];
  const selectedPoint = interactive && selectedPiece
    ? getPositionPoint(selectedPiece.position, orientation)
    : null;
  const lastMoveFromPoint = getPositionPoint(lastMove?.from, orientation);
  const lastMoveToPoint = getPositionPoint(lastMove?.to, orientation);

  useEffect(() => {
    setSelectedPieceId(null);
  }, [boardPositionSignature, interactive, orientation]);

  function handleClick(event) {
    if (!interactive || movePending) return;
    const targetPosition = getPositionAt(event.currentTarget, event.clientX, event.clientY, orientation);
    if (!targetPosition) return;

    const targetPiece = pieces.find((piece) => piece.position === targetPosition);
    if (targetPiece?.color === playerColor) {
      if (targetPiece.id === selectedPieceId) {
        setSelectedPieceId(null);
      } else {
        setSelectedPieceId(targetPiece.id);
        onSelectPiece(targetPiece.position);
      }
      return;
    }

    if (selectedPiece) {
      const isLegalDestination = legalDestinations.includes(targetPosition);
      if (isLegalDestination) {
        onMove(selectedPiece.position, targetPosition);
        setSelectedPieceId(null);
      }
    }
  }

  function handleLegalDestinationClick(event, destination) {
    event.stopPropagation();
    if (!interactive || movePending || !selectedPiece || !legalDestinations.includes(destination)) return;
    onMove(selectedPiece.position, destination);
    setSelectedPieceId(null);
  }

  function handleLegalDestinationKeyDown(event, destination) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handleLegalDestinationClick(event, destination);
  }

  return (
    <div className="xiangqi-board-frame">
      <div className="board-coordinate coordinate-top">
        {coordinates.map((file) => <span key={file}>{file}</span>)}
      </div>
      <svg
        className="xiangqi-board"
        viewBox="0 0 900 1000"
        role={interactive ? 'application' : 'img'}
        aria-label={`Bàn cờ Tướng 9 cột 10 hàng với ${pieces.length} quân${readOnly ? ', chế độ chỉ xem' : ''}`}
        onClick={handleClick}
      >
        <defs>
          <linearGradient id="board-wood" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#644126" />
            <stop offset="17%" stopColor="#bd8a51" />
            <stop offset="40%" stopColor="#87552e" />
            <stop offset="65%" stopColor="#d0a064" />
            <stop offset="83%" stopColor="#94643a" />
            <stop offset="100%" stopColor="#55351f" />
          </linearGradient>
          <pattern id="wood-grain" width="180" height="112" patternUnits="userSpaceOnUse">
            <path d="M -20 19 C 24 4 54 31 96 17 S 156 7 202 22 M -18 53 C 22 39 58 64 103 49 S 158 43 198 56 M -16 88 C 28 72 67 99 112 83 S 163 77 199 91" fill="none" stroke="#f1cf9a" strokeOpacity=".26" strokeWidth="1.4" />
            <path d="M -20 34 C 24 20 54 46 96 32 S 156 22 202 37 M -18 70 C 22 56 58 81 103 66 S 158 60 198 73" fill="none" stroke="#4c2c19" strokeOpacity=".22" strokeWidth="1" />
          </pattern>
          <linearGradient id="board-paper" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#eee0bf" />
            <stop offset="48%" stopColor="#e4d0a8" />
            <stop offset="100%" stopColor="#dcc497" />
          </linearGradient>
          <radialGradient id="piece-ivory" cx=".29" cy=".2" r=".88">
            <stop offset="0%" stopColor="#fffef5" />
            <stop offset="43%" stopColor="#f3e5ca" />
            <stop offset="78%" stopColor="#dfcaa3" />
            <stop offset="100%" stopColor="#bca27b" />
          </radialGradient>
          <linearGradient id="piece-bronze" x1="0" y1="0" x2="0.85" y2="1">
            <stop offset="0%" stopColor="#f6dba5" />
            <stop offset="25%" stopColor="#a47543" />
            <stop offset="52%" stopColor="#f1d29a" />
            <stop offset="100%" stopColor="#62401f" />
          </linearGradient>
          <linearGradient id="piece-bevel" x1="0" y1="0" x2="0.8" y2="1">
            <stop offset="0%" stopColor="#fff0cf" />
            <stop offset="55%" stopColor="#cfb486" />
            <stop offset="100%" stopColor="#8f7049" />
          </linearGradient>
          <linearGradient id="piece-red-ink" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#c84d3f" />
            <stop offset="100%" stopColor="#8f2e27" />
          </linearGradient>
          <linearGradient id="piece-black-ink" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#51534d" />
            <stop offset="100%" stopColor="#282b28" />
          </linearGradient>
          <filter id="board-grain">
            <feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="2" seed="7" />
            <feColorMatrix type="saturate" values="0" />
            <feComponentTransfer>
              <feFuncA type="table" tableValues="0 .08" />
            </feComponentTransfer>
            <feBlend in="SourceGraphic" mode="multiply" />
          </filter>
        </defs>
        <rect className="board-wood-mat" x="8" y="4" width="884" height="992" rx="17" fill="url(#board-wood)" />
        <rect className="board-wood-grain" x="9" y="5" width="882" height="990" rx="16" fill="url(#wood-grain)" />
        <rect className="board-wood-inset" x="19" y="15" width="862" height="970" rx="12" />
        <rect className="board-paper" x="22" y="17" width="856" height="966" rx="9" fill="url(#board-paper)" />
        <rect className="board-border" x="29" y="24" width="842" height="952" rx="5" />
        <g filter="url(#board-grain)">
          <BoardGrid />
        </g>
        <BoardDetails />
        <g className="river-label" aria-hidden="true">
          <text x="290" y="511" textAnchor="middle">SỞ HÀ</text>
          <text x="610" y="511" textAnchor="middle">HÁN GIỚI</text>
        </g>
        <g className="board-coordinates" aria-hidden="true">
          {Array.from({ length: 10 }, (_, rank) => {
            const { y } = point(0, rank, orientation);
            return <text key={`rank-label-${rank}`} x="40" y={y + 4} textAnchor="middle">{rank}</text>;
          })}
        </g>
        {checkedPoint && (
          <g className="check-highlight-layer" aria-hidden="true">
            <circle cx={checkedPoint.x} cy={checkedPoint.y} r="39" />
          </g>
        )}
        {capturePoint && (
          <g key={captureEffect.key} className="capture-effect-layer" aria-hidden="true">
            {captureEffect.capturedPiece && (
              <g transform={`translate(${capturePoint.x} ${capturePoint.y})`}>
                <g className={`captured-piece-exit ${captureEffect.capturedPiece.color}`}>
                  <circle className="captured-piece-shadow" cx="2" cy="5" r="34" />
                  <circle className="captured-piece-rim" r="32" />
                  <circle className="captured-piece-face" cy="-1" r="28" />
                  <text
                    className={`captured-piece-label ${captureEffect.capturedPiece.color}`}
                    textAnchor="middle"
                    dominantBaseline="central"
                    textLength={PIECE_LABELS[captureEffect.capturedPiece.type].length > 3 ? 42 : undefined}
                    lengthAdjust="spacingAndGlyphs"
                  >
                    {PIECE_LABELS[captureEffect.capturedPiece.type]}
                  </text>
                </g>
              </g>
            )}
            <circle className="capture-flash" cx={capturePoint.x} cy={capturePoint.y} r="12" />
            <circle className="capture-ring" cx={capturePoint.x} cy={capturePoint.y} r="18" />
            <path
              className="capture-sparks"
              d={`M ${capturePoint.x} ${capturePoint.y - 24} v -11
                M ${capturePoint.x + 17} ${capturePoint.y - 17} l 8 -8
                M ${capturePoint.x + 24} ${capturePoint.y} h 11
                M ${capturePoint.x + 17} ${capturePoint.y + 17} l 8 8
                M ${capturePoint.x} ${capturePoint.y + 24} v 11
                M ${capturePoint.x - 17} ${capturePoint.y + 17} l -8 8
                M ${capturePoint.x - 24} ${capturePoint.y} h -11
                M ${capturePoint.x - 17} ${capturePoint.y - 17} l -8 -8`}
            />
          </g>
        )}
        {capturePoint && captureEffect.capturedPiece && (
          <g className="captured-piece-trail" aria-hidden="true">
            <circle cx={capturePoint.x - 18} cy={capturePoint.y + 5} r="4" />
            <circle cx={capturePoint.x + 20} cy={capturePoint.y - 7} r="3" />
            <circle cx={capturePoint.x + 5} cy={capturePoint.y + 21} r="2.5" />
          </g>
        )}
        <g className="pieces-layer">
          {pieces.map((piece) => (
            <Piece
              key={pieceRenderIds.get(piece.position)}
              piece={piece}
              orientation={orientation}
              selected={piece.id === selectedPieceId}
              interactive={interactive && piece.color === playerColor}
            />
          ))}
        </g>
        {legalDestinations.length > 0 && (
          <g className="legal-move-layer" aria-label="Các vị trí có thể đi">
            {legalDestinations.map((destination) => {
              const destinationPoint = getPositionPoint(destination, orientation);
              const targetPiece = pieces.find((piece) => piece.position === destination);
              if (!destinationPoint) return null;
              return (
                <g
                  key={destination}
                  className={`legal-move-marker${targetPiece ? ' is-capture-target' : ''}`}
                  transform={`translate(${destinationPoint.x} ${destinationPoint.y})`}
                  aria-label={`${targetPiece ? 'Ăn quân tại' : 'Đi đến'} ${destination}`}
                  data-destination={destination}
                  role="button"
                  tabIndex={0}
                  onClick={(event) => handleLegalDestinationClick(event, destination)}
                  onKeyDown={(event) => handleLegalDestinationKeyDown(event, destination)}
                >
                  <circle className="legal-move-hit-area" r="25" />
                  {targetPiece ? (
                    <path d={getCornerPath({ x: 0, y: 0 }, 35, 10)} />
                  ) : (
                    <>
                      <circle className="legal-move-target-ring" r="18" />
                      <circle className="legal-move-glow" r="13" />
                      <circle className="legal-move-dot" r="6" />
                    </>
                  )}
                </g>
              );
            })}
          </g>
        )}
        {lastMoveFromPoint && lastMoveToPoint && (
          <g
            className={`last-move-marker last-move-${lastMove.color || 'red'}`}
            aria-label={`Nước đi gần nhất: ${lastMove.from} đến ${lastMove.to}`}
          >
            <path
              className="last-move-origin"
              d={getCornerPath(lastMoveFromPoint, 31, 18)}
            />
            <path
              className="last-move-destination"
              d={getCornerPath(lastMoveToPoint, 36, 20)}
            />
          </g>
        )}
        {interactive && selectedPoint && (
          <g
            className="selection-energy-layer"
            transform={`translate(${selectedPoint.x} ${selectedPoint.y})`}
            aria-hidden="true"
          >
            <circle className="selection-energy-ring selection-energy-ring-outer" r="38" />
            <circle className="selection-energy-ring selection-energy-ring-inner" r="36" />
          </g>
        )}
      </svg>
      <div className="board-coordinate coordinate-bottom">
        {coordinates.map((file) => <span key={file}>{file}</span>)}
      </div>
      {readOnly && <div className="board-readonly-tag"><span>◉</span> CHẾ ĐỘ QUAN SÁT</div>}
      {countdown !== null && (
        <div className="countdown-overlay" role="status" aria-live="assertive">
          <span className="countdown-caption">TRẬN ĐẤU BẮT ĐẦU SAU</span>
          <strong key={countdown} className="countdown-number">{countdown}</strong>
          <span className="countdown-subtitle">Chuẩn bị sẵn sàng</span>
        </div>
      )}
    </div>
  );
}
