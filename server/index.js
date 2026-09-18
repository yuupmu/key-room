import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SCORE_MODEL, SCORE_REASONING_EFFORT, handleScoreReview, handleScoreStatus, handleScoreToMidi } from './score-to-midi.js';
import { handleSongSearch, SONG_SEARCH_MODEL } from './song-search.js';
import { UNFOLD_SCORE_MODEL, UNFOLD_SCORE_REASONING_EFFORT, handleUnfoldScore } from './unfold-score.js';
import { handleChordChart, handleChordArrangement } from './chord-to-score.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(projectRoot, '.env');
if (existsSync(envFile)) {
  if (typeof process.loadEnvFile !== 'function') throw new Error('.env 사용에는 Node.js 20.12 이상이 필요합니다.');
  process.loadEnvFile(envFile);
}
const development = process.argv.includes('--dev');
const publicDir = join(projectRoot, development ? 'src/client' : 'dist/client');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.woff2': 'font/woff2'
};

function respond(response, status, text) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(text);
}

const server = createServer(async (request, response) => {
  if (request.url?.split('?')[0] === '/api/score-to-midi/status') {
    handleScoreStatus(request, response);
    return;
  }
  if (request.url?.split('?')[0] === '/api/score-to-midi/review') {
    await handleScoreReview(request, response);
    return;
  }
  if (request.url?.split('?')[0] === '/api/score-to-midi') {
    await handleScoreToMidi(request, response);
    return;
  }
  if (request.url?.split('?')[0] === '/api/song-search') {
    await handleSongSearch(request, response);
    return;
  }
  if (request.url?.split('?')[0] === '/api/unfold-score') {
    await handleUnfoldScore(request, response);
    return;
  }
  if (request.url?.split('?')[0] === '/api/chord-chart') {
    await handleChordChart(request, response);
    return;
  }
  if (request.url?.split('?')[0] === '/api/chord-arrangement') {
    await handleChordArrangement(request, response);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    respond(response, 405, 'Method not allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${host}`).pathname);
  } catch {
    respond(response, 400, 'Bad request');
    return;
  }

  if (pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok', mode: development ? 'development' : 'production', scoreApi: true, scoreModel: process.env.OPENAI_SCORE_TO_MIDI_MODEL || DEFAULT_SCORE_MODEL, scoreReasoning: SCORE_REASONING_EFFORT, unfoldScoreApi: true, unfoldScoreModel: UNFOLD_SCORE_MODEL, unfoldScoreReasoning: UNFOLD_SCORE_REASONING_EFFORT, songSearchApi: true, songSearchModel: SONG_SEARCH_MODEL, songSearchReasoning: 'high', apiKeyConfigured: !!process.env.OPENAI_API_KEY }));
    return;
  }

  const requestedPath = join(publicDir, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  const relativePath = relative(publicDir, requestedPath);
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    respond(response, 403, 'Forbidden');
    return;
  }
  const publicPath = development && pathname === '/signalsmith-stretch.mjs'
    ? join(projectRoot, 'node_modules', 'signalsmith-stretch', 'SignalsmithStretch.mjs')
    : development && pathname === '/pdf-lib.min.js'
    ? join(projectRoot, 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.min.js')
    : requestedPath;
  try {
    const info = await stat(publicPath);
    if (!info.isFile()) {
      respond(response, 404, 'Not found');
      return;
    }
    const body = await readFile(publicPath);
    response.writeHead(200, {
      'Content-Type': types[extname(publicPath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': development ? 'no-store' : 'public, max-age=300'
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    respond(response, error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
});

server.listen(port, host, () => {
  console.log(`Keyroom ${development ? 'development' : 'production'} server`);
  console.log(`Local: http://${host}:${port}`);
  console.log(`Score API: ${process.env.OPENAI_SCORE_TO_MIDI_MODEL || DEFAULT_SCORE_MODEL} (${process.env.OPENAI_API_KEY ? 'API key configured' : 'API key missing'})`);
});
