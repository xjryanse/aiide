export interface SseEvent {
  event: string;
  data: any;
}

export type ChatMode = 'ask' | 'agent' | 'debug';

export interface ChatRequestBody {
  session_id?: string | null;
  message: string;
  workspace?: string | null;
  images?: string[] | null;
  mode?: ChatMode;
}

/**
 * 向 Python /v1/chat/stream 发起 SSE 请求,逐条 yield 事件。
 */
export async function* streamChat(
  baseUrl: string,
  body: ChatRequestBody,
  signal?: AbortSignal
): AsyncGenerator<SseEvent, void, void> {
  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${text || resp.statusText}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseSseBlock(block);
      if (parsed) yield parsed;
    }
  }
}

function parseSseBlock(block: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: { raw } };
  }
}

export async function getConfig(baseUrl: string): Promise<any> {
  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/config`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}
