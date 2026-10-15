const { URL } = require('node:url');
const { getPublicMatchState } = require('../../../domain/entities/cot615Match');

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  response.end(JSON.stringify(body));
}

function createMatchesHandler({ getMatch, now = Date.now }) {
  return (request, response) => {
    if (request.method === 'OPTIONS') {
      sendJson(response, 204, {});
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      sendJson(response, 400, { error: 'Invalid request URL' });
      return;
    }

    const matchRoute = pathname.match(/^\/api\/matches\/([^/]+)$/);
    if (request.method !== 'GET' || !matchRoute) {
      sendJson(response, 404, { error: 'Route not found' });
      return;
    }

    let matchId;
    try {
      matchId = decodeURIComponent(matchRoute[1]);
    } catch {
      sendJson(response, 400, { error: 'Invalid match ID' });
      return;
    }

    const match = getMatch();
    if (matchId !== match.id) {
      sendJson(response, 404, { error: `Match '${matchId}' was not found` });
      return;
    }

    sendJson(response, 200, getPublicMatchState(match, now()));
  };
}

module.exports = { createMatchesHandler };
