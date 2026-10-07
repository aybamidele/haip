import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPublicCalendar } from './ical-fetch';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:http', () => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));

let connected: RequestOptions & { autoSelectFamily?: boolean };
let reply: IncomingMessage;
let onReply: (response: IncomingMessage) => void;
let outgoing: EventEmitter;
const text = 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR';

beforeEach(() => {
  vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  const request = (_url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    connected = options;
    onReply = callback;
    reply = Object.assign(new PassThrough(), { headers: {}, statusCode: 200, complete: true }) as unknown as IncomingMessage;
    outgoing = Object.assign(new EventEmitter(), { end: () => undefined });
    options.signal?.addEventListener('abort', () => outgoing.emit('error', new Error('url?private-token')));
    return outgoing;
  };
  vi.mocked(httpRequest).mockImplementation(request as unknown as typeof httpRequest);
  vi.mocked(httpsRequest).mockImplementation(request as unknown as typeof httpsRequest);
});
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });
async function started() { await vi.waitFor(() => expect(httpsRequest).toHaveBeenCalledOnce()); }

describe('public calendar download', () => {
  it('pins the connection to the validated address without changing TLS host or following redirects', async () => {
    const pending = fetchPublicCalendar('https://calendar.example.com/secret.ics?token=private-token');
    await started();
    expect(lookup).toHaveBeenCalledOnce();
    expect(connected.agent).toBe(false);
    expect(connected.autoSelectFamily).toBe(true);
    expect(vi.mocked(httpsRequest).mock.calls[0]?.[0]).toBeInstanceOf(URL);
    expect((vi.mocked(httpsRequest).mock.calls[0]?.[0] as URL).hostname).toBe('calendar.example.com');
    const resolved = vi.fn();
    connected.lookup?.('calendar.example.com', { family: 4, hints: 0 }, resolved);
    expect(resolved).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(lookup).toHaveBeenCalledOnce();
    onReply(reply); reply.end(text);
    await expect(pending).resolves.toBe(text);
  });
  it('rejects mixed public/private DNS answers before opening a connection', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] as never);
    await expect(fetchPublicCalendar('https://calendar.example.com/')).rejects.toThrow(/private/);
    expect(httpsRequest).not.toHaveBeenCalled();
  });
  it('rejects mapped loopback without opening a connection', async () => {
    await expect(fetchPublicCalendar('http://[::ffff:127.0.0.1]/')).rejects.toThrow(/not allowed/);
    expect(httpRequest).not.toHaveBeenCalled();
  });
  it('rejects redirects without requesting the destination or exposing its URL', async () => {
    const pending = fetchPublicCalendar('https://calendar.example.com/');
    const rejected = expect(pending).rejects.toThrow(/^Calendar provider returned HTTP 302$/);
    await started(); reply.statusCode = 302; reply.headers.location = 'http://127.0.0.1/?token=private-token'; onReply(reply);
    await rejected;
    expect(httpsRequest).toHaveBeenCalledOnce(); expect(httpRequest).not.toHaveBeenCalled();
  });
  it('bounds a streaming response even without Content-Length', async () => {
    const pending = fetchPublicCalendar('https://calendar.example.com/', { maxBytes: 10 });
    const rejected = expect(pending).rejects.toThrow(/size limit/);
    await started(); onReply(reply); reply.write('123456'); reply.write('78901');
    await rejected; expect(reply.destroyed).toBe(true);
  });
  it('rejects oversized declared bodies before buffering', async () => {
    const pending = fetchPublicCalendar('https://calendar.example.com/', { maxBytes: 10 });
    const rejected = expect(pending).rejects.toThrow(/size limit/);
    await started(); reply.headers['content-length'] = '11'; onReply(reply); await rejected;
  });
  it('bounds time spent resolving DNS', async () => {
    vi.mocked(lookup).mockImplementation(() => new Promise(() => undefined));
    await expect(fetchPublicCalendar('https://calendar.example.com/', { timeoutMs: 20 })).rejects.toThrow(/^Calendar request timed out$/);
    expect(httpsRequest).not.toHaveBeenCalled();
  });
  it('bounds time spent waiting for a provider response without retaining network error text', async () => {
    const pending = fetchPublicCalendar('https://calendar.example.com/', { timeoutMs: 50 });
    await expect(pending).rejects.toThrow(/^Calendar request timed out$/);
  });
  it('rejects unexpected compression instead of allowing an unbounded decompressed response', async () => {
    const pending = fetchPublicCalendar('https://calendar.example.com/');
    const rejected = expect(pending).rejects.toThrow(/encoding/);
    await started(); reply.headers['content-encoding'] = 'gzip'; onReply(reply); await rejected;
  });
});
