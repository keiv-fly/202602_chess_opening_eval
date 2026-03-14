import * as dotenv from 'dotenv';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readBrowserPageCss, renderBrowserPage } from './browserPage.js';
import { listCards } from './cards.js';
import { OpeningEvaluator } from './openingEvaluator.js';
import type { BrowserResultEvent, EvaluatePositionRequest, EvaluatePositionResult, UiEvent } from './types.js';

dotenv.config();

type JobRecord = {
  id: string;
  events: UiEvent[];
  listeners: Set<ServerResponse>;
  result: EvaluatePositionResult | null;
  done: boolean;
};

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const evaluator = new OpeningEvaluator();
const jobs = new Map<string, JobRecord>();

function openBrowser(url: string): void {
  const command =
    process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] };

  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (error) => {
    console.warn(`Warning: failed to open browser automatically: ${error.message}`);
  });
  child.unref();
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function writeHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
}

function writeCss(response: ServerResponse, css: string): void {
  response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
  response.end(css);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') {
    return {} as T;
  }

  return JSON.parse(raw) as T;
}

function sendSseEvent(response: ServerResponse, event: UiEvent): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcastJobEvent(job: JobRecord, event: UiEvent): void {
  job.events.push(event);
  for (const response of job.listeners) {
    sendSseEvent(response, event);
    if (event.type === 'done') {
      response.end();
    }
  }

  if (event.type === 'done') {
    job.listeners.clear();
    job.done = true;
  }
}

function scheduleJobCleanup(jobId: string): void {
  const timeout = setTimeout(() => {
    jobs.delete(jobId);
  }, 30 * 60 * 1000);
  timeout.unref();
}

function createJob(): JobRecord {
  const job: JobRecord = {
    id: randomUUID(),
    events: [],
    listeners: new Set(),
    result: null,
    done: false,
  };
  jobs.set(job.id, job);
  scheduleJobCleanup(job.id);
  return job;
}

async function runJob(job: JobRecord, request: EvaluatePositionRequest): Promise<void> {
  try {
    const result = await evaluator.evaluate(request, {
      onLog: (message) => {
        broadcastJobEvent(job, { type: 'log', message });
      },
      onProgress: (update) => {
        broadcastJobEvent(job, { type: 'progress', ...update });
      },
      onRetryPrompt: (prompt) => {
        broadcastJobEvent(job, {
          type: 'log',
          message:
            `Status: Cloud eval retry needed (${prompt.retryIndex}/${prompt.maxRetries}, wait ~${prompt.waitSeconds}s): ` +
            `${prompt.requestDescription} -> using cached values automatically in browser mode.`,
        });
        return 'use-cached-values';
      },
    });

    job.result = result;
    const { boardText: _boardText, ...browserResult } = result;
    broadcastJobEvent(job, { type: 'result', ...browserResult } satisfies BrowserResultEvent);
    broadcastJobEvent(job, { type: 'done' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    broadcastJobEvent(job, { type: 'error', message });
    broadcastJobEvent(job, { type: 'done' });
  }
}

function handleSse(request: IncomingMessage, response: ServerResponse, jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) {
    writeJson(response, 404, { error: 'Job not found.' });
    return;
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  response.write(': connected\n\n');

  for (const event of job.events) {
    sendSseEvent(response, event);
  }

  if (job.done) {
    response.end();
    return;
  }

  job.listeners.add(response);
  request.on('close', () => {
    job.listeners.delete(response);
  });
}

const server = createServer(async (request, response) => {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (method === 'GET' && url.pathname === '/browser/browserPage.css') {
    writeCss(response, readBrowserPageCss());
    return;
  }

  if (method === 'GET' && url.pathname === '/') {
    writeHtml(
      response,
      renderBrowserPage({
        lichessUser: process.env.LICHESS_USER ?? '',
        chessComUser: process.env.CHESSCOM_USER ?? '',
      }),
    );
    return;
  }

  if (method === 'POST' && url.pathname === '/api/evaluate') {
    try {
      const body = await readJsonBody<Partial<EvaluatePositionRequest>>(request);
      const evaluateRequest: EvaluatePositionRequest = {
        lichessUser: typeof body.lichessUser === 'string' ? body.lichessUser : '',
        chessComUser: typeof body.chessComUser === 'string' ? body.chessComUser : '',
        initialPosition: typeof body.initialPosition === 'string' ? body.initialPosition : '',
        history: Array.isArray(body.history) ? body.history.filter((value): value is string => typeof value === 'string') : [],
        side: body.side === 'black' ? 'black' : 'white',
        timeFilter: typeof body.timeFilter === 'string' ? body.timeFilter : '',
        forceRefreshUserGames: Boolean(body.forceRefreshUserGames),
        preferDownloadedUserGames: Boolean(body.preferDownloadedUserGames),
      };

      const job = createJob();
      void runJob(job, evaluateRequest);
      writeJson(response, 202, { jobId: job.id });
    } catch (error: unknown) {
      writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (method === 'POST' && url.pathname === '/api/export') {
    try {
      const body = await readJsonBody<{ jobId?: string }>(request);
      if (!body.jobId) {
        writeJson(response, 400, { error: 'jobId is required.' });
        return;
      }

      const job = jobs.get(body.jobId);
      if (!job || !job.result) {
        writeJson(response, 404, { error: 'Completed job result not found.' });
        return;
      }

      const filePath = await evaluator.exportRowsToCsv(job.result.rows, job.result.fen, job.result.side);
      writeJson(response, 200, { path: filePath });
    } catch (error: unknown) {
      writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (method === 'POST' && url.pathname === '/api/cards') {
    try {
      const body = await readJsonBody<{ jobId?: string; moveSan?: string }>(request);
      if (!body.jobId) {
        writeJson(response, 400, { error: 'jobId is required.' });
        return;
      }
      if (typeof body.moveSan !== 'string' || body.moveSan.trim() === '') {
        writeJson(response, 400, { error: 'moveSan is required.' });
        return;
      }

      const job = jobs.get(body.jobId);
      if (!job || !job.result) {
        writeJson(response, 404, { error: 'Completed job result not found.' });
        return;
      }

      const savedCard = await evaluator.saveCard(job.result.fen, body.moveSan);
      writeJson(response, 201, savedCard);
    } catch (error: unknown) {
      writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (method === 'GET' && url.pathname === '/api/cards') {
    try {
      const cards = await listCards();
      writeJson(response, 200, { cards });
    } catch (error: unknown) {
      writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const eventsMatch = /^\/api\/jobs\/([^/]+)\/events$/u.exec(url.pathname);
  if (method === 'GET' && eventsMatch) {
    handleSse(request, response, decodeURIComponent(eventsMatch[1]));
    return;
  }

  writeJson(response, 404, { error: 'Not found.' });
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Chess Opening Eval browser UI: ${url}`);
  openBrowser(url);
});
