/** One small HTTP helper for public pages and APIs: a timeout, a browser-like User-Agent and a size cap. */

export async function fetchText(url: string, opts: { accept: string; timeoutMs: number }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    // Some sites (e.g. Wikipedia) reject the HTTP library's default User-Agent.
    const res = await fetch(url, { headers: { Accept: opts.accept, 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 Qivra/1.1' }, signal: ctl.signal });
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > 3_000_000) return { ok: false, status: 413, text: '', contentType: '' };
    return { ok: res.ok, status: res.status, text: await res.text(), contentType: res.headers.get('content-type') ?? '' };
  } finally {
    clearTimeout(t);
  }
}
