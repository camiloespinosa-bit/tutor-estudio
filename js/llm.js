// Conexión con los modelos a través de OpenRouter (https://openrouter.ai).
// La clave se guarda solo en este navegador y se envía únicamente a openrouter.ai.

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function headers(apiKey) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': location.origin,
    'X-Title': 'Tutor de estudio',
  };
}

async function explainHttpError(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.error?.message || JSON.stringify(j);
  } catch { /* sin cuerpo */ }
  if (res.status === 401) return 'La clave de OpenRouter no es válida. Revísala en Ajustes.';
  if (res.status === 402) return 'Tu cuenta de OpenRouter no tiene saldo suficiente.';
  if (res.status === 429) return 'Demasiadas solicitudes seguidas. Espera un momento e intenta de nuevo.';
  return `Error ${res.status} del servicio de IA. ${detail}`.trim();
}

// Respuesta en streaming: llama onDelta(textoAcumulado) a medida que llega.
export async function streamChat({ apiKey, model, messages, onDelta, signal, maxTokens = 2000 }) {
  if (!apiKey) throw new Error('Falta tu clave de OpenRouter. Agrégala en Ajustes (⚙︎).');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens, usage: { include: true } }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(await explainHttpError(res));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // comentarios de keep-alive
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        if (j.error) throw new Error(j.error.message || 'Error del modelo');
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) { text += delta; onDelta?.(text); }
        if (j.usage) usage = j.usage;
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  return { text, usage };
}

export async function complete({ apiKey, model, messages, maxTokens = 4000 }) {
  if (!apiKey) throw new Error('Falta tu clave de OpenRouter. Agrégala en Ajustes (⚙︎).');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, usage: { include: true } }),
  });
  if (!res.ok) throw new Error(await explainHttpError(res));
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'Error del modelo');
  return { text: j.choices?.[0]?.message?.content || '', usage: j.usage || null };
}

// Extrae el primer bloque JSON de la respuesta (los modelos a veces lo envuelven en ```json).
export function parseJSON(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.search(/[[{]/);
  if (start < 0) throw new Error('El modelo no devolvió datos en el formato esperado.');
  const open = cleaned[start];
  const close = open === '[' ? ']' : '}';
  const end = cleaned.lastIndexOf(close);
  return JSON.parse(cleaned.slice(start, end + 1));
}

export function formatCost(usage) {
  if (!usage) return '';
  const parts = [];
  if (typeof usage.cost === 'number') parts.push(`US$ ${usage.cost.toFixed(4)}`);
  if (usage.prompt_tokens) parts.push(`${usage.prompt_tokens + (usage.completion_tokens || 0)} tokens`);
  return parts.join(' · ');
}
