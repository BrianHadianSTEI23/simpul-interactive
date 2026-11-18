/** Same-origin REST adapter (supports optional window.SIMPUL_API_BASE override). */
export async function apiRequest(path, { method = 'GET', body, timeout = 20000 } = {}) {
  if (location.protocol === 'file:') {
    throw new Error('Backend API requires HTTP serving.');
  }
  const base = (typeof window !== 'undefined' && window.SIMPUL_API_BASE) ? String(window.SIMPUL_API_BASE).replace(/\/$/, '') : '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = typeof data.detail === 'string'
        ? data.detail
        : (data.detail?.reason || `API returned HTTP ${res.status}`);
      throw new Error(msg);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}
