import type { Response } from 'express';

export type StoryEvent =
  | { type: 'project'; project: string }
  | { type: 'scene'; project: string; scene: string; version: number }
  | { type: 'assets'; project: string; version: number }
  | { type: 'chat'; project: string; scope: string; message: unknown }
  | { type: 'chat-delta'; project: string; scope: string; id: string; text: string }
  | { type: 'render'; project: string; job: unknown }
  | { type: 'score'; project: string; status: 'rendering' | 'done' | 'error'; message?: string }
  | { type: 'sounds'; project: string };

const clients = new Set<Response>();

export function subscribe(res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  res.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function emit(event: StoryEvent) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(payload);
}
