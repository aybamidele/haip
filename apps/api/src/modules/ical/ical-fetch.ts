import { request as httpRequest, type RequestOptions } from 'node:http';
import type { TcpSocketConnectOpts } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { resolveSafeOutboundUrl } from '../../common/security/url-guard';

export class CalendarFetchError extends Error {}

/** Bounded download, no redirects, and connection DNS bound to validated public IPs. */
export async function fetchPublicCalendar(
  raw: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<string> {
  if (raw.length > 4096) throw new CalendarFetchError('Calendar URL exceeds size limit');
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 1_048_576;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const target = await Promise.race([
      resolveSafeOutboundUrl(raw),
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new CalendarFetchError('Calendar request timed out')), { once: true })),
    ]);
    if (controller.signal.aborted) throw new CalendarFetchError('Calendar request timed out');
    const address = target.addresses[0]!;
    const lookup: RequestOptions['lookup'] = (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, target.addresses);
      else callback(null, address.address, address.family);
    };
    return await new Promise<string>((resolve, reject) => {
      const connectionOptions: RequestOptions & Pick<TcpSocketConnectOpts, 'autoSelectFamily'> = {
        agent: false, lookup, autoSelectFamily: true, signal: controller.signal,
        headers: { Accept: 'text/calendar, text/plain;q=0.9', 'Accept-Encoding': 'identity' },
      };
      const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(target.url, connectionOptions, (response) => {
        const fail = (message: string) => {
          reject(new CalendarFetchError(message));
          response.destroy();
        };
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) return fail(`Calendar provider returned HTTP ${status}`);
        const encoding = response.headers['content-encoding'];
        if (encoding && encoding !== 'identity') return fail('Calendar response encoding is not supported');
        if (Number(response.headers['content-length'] ?? 0) > maxBytes) return fail('Calendar response exceeds size limit');
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) return fail('Calendar response exceeds size limit');
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (!response.complete) return fail('Calendar response was interrupted');
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        response.on('error', () => reject(new CalendarFetchError('Calendar response was interrupted')));
      });
      request.on('error', () => reject(new CalendarFetchError(controller.signal.aborted ? 'Calendar request timed out' : 'Calendar connection failed')));
      request.end();
    });
  } finally {
    clearTimeout(timer);
  }
}
