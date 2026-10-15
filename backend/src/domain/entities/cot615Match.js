const backRank = [
  ['chariot', 'a'],
  ['horse', 'b'],
  ['elephant', 'c'],
  ['advisor', 'd'],
  ['general', 'e'],
  ['advisor', 'f'],
  ['elephant', 'g'],
  ['horse', 'h'],
  ['chariot', 'i'],
];

function createArmy(color, backRankNumber, cannonRank, soldierRank) {
  const pieces = backRank.map(([type, file]) => ({
    id: `${color}-${type}-${file}${backRankNumber}`,
    color,
    type,
    position: `${file}${backRankNumber}`,
  }));

  pieces.push(
    { id: `${color}-cannon-b${cannonRank}`, color, type: 'cannon', position: `b${cannonRank}` },
    { id: `${color}-cannon-h${cannonRank}`, color, type: 'cannon', position: `h${cannonRank}` },
  );

  for (const file of ['a', 'c', 'e', 'g', 'i']) {
    pieces.push({
      id: `${color}-soldier-${file}${soldierRank}`,
      color,
      type: 'soldier',
      position: `${file}${soldierRank}`,
    });
  }

  return pieces;
}

function createCot615Match(startedAt = Date.now()) {
  return {
    id: 'COT-615',
    roomName: 'Phòng thi đấu',
    matchCode: 'COT-615',
    title: 'Kỳ đài giao hữu',
    status: 'starting',
    assignedAt: new Date(startedAt).toISOString(),
    startsAt: new Date(startedAt + 3000).toISOString(),
    currentTurn: 'red',
    moveNumber: 1,
    viewerCount: 1,
    initialClockSeconds: 120,
    players: {
      red: { name: 'Nguyễn Nhật Trường', rating: 1240 },
      black: { name: 'Đối thủ', rating: 1286 },
    },
    board: [
      ...createArmy('red', 0, 2, 3),
      ...createArmy('black', 9, 7, 6),
    ],
  };
}

function getPublicMatchState(match, now = Date.now()) {
  const startsAt = Date.parse(match.startsAt);
  const remainingCountdown = Math.max(0, Math.ceil((startsAt - now) / 1000));
  const elapsedSeconds = Math.max(0, Math.floor((now - startsAt) / 1000));
  const isActive = remainingCountdown === 0;
  const activePlayer = isActive ? match.currentTurn : null;

  return {
    id: match.id,
    roomName: match.roomName,
    matchCode: match.matchCode,
    title: match.title,
    status: isActive ? 'active' : 'starting',
    countdownSeconds: isActive ? null : remainingCountdown,
    currentTurn: match.currentTurn,
    moveNumber: match.moveNumber,
    viewerCount: match.viewerCount,
    timeControlSeconds: match.initialClockSeconds,
    clocks: {
      red: Math.max(0, match.initialClockSeconds - (activePlayer === 'red' ? elapsedSeconds : 0)),
      black: Math.max(0, match.initialClockSeconds - (activePlayer === 'black' ? elapsedSeconds : 0)),
    },
    players: match.players,
    board: match.board,
  };
}

module.exports = { createCot615Match, getPublicMatchState };
