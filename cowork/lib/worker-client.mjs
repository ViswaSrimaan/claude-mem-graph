// Tiny client for the optional local viewer/worker.

export function workerUrl(settings) {
  return `http://${settings.worker.host}:${settings.worker.port}`;
}

export async function isWorkerUp(settings, timeoutMs = 800) {
  try {
    const res = await fetch(`${workerUrl(settings)}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.app === 'claude-mem-local' ? body : false;
  } catch {
    return false;
  }
}

export async function stopWorker(settings) {
  try {
    const res = await fetch(`${workerUrl(settings)}/api/shutdown`, {
      method: 'POST',
      headers: { 'x-cmem-local': '1' },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
