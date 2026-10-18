// Lectura de PDFs y selección del contexto que se envía al modelo.

const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

// Hasta este tamaño se envía el documento completo (y se aprovecha la caché de prompts).
// Por encima, se envían solo las páginas más relacionadas con la pregunta.
export const FULL_DOC_CHARS = 160000;
const RETRIEVAL_BUDGET = 60000;
export const RANGE_BUDGET = 120000;

export async function extractPdf(file, onProgress) {
  const data = new Uint8Array(await file.arrayBuffer());
  // isEvalSupported: false cierra una vulnerabilidad conocida de pdf.js con PDFs maliciosos.
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      text += item.str;
      text += item.hasEOL ? '\n' : ' ';
    }
    pages.push(text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
    page.cleanup();
    onProgress?.(i / pdf.numPages);
  }
  await pdf.destroy();
  const emptyPages = pages.filter((p) => p.length < 30).length;
  return {
    pages,
    chars: pages.reduce((n, p) => n + p.length, 0),
    looksScanned: emptyPages / pages.length > 0.5,
  };
}

export function pageBlock(doc, i) {
  return `[Página ${i + 1}]\n${doc.pages[i]}`;
}

export function rangeText(doc, from, to, budget = RANGE_BUDGET) {
  const out = [];
  let used = 0;
  let truncated = false;
  for (let i = Math.max(0, from - 1); i < Math.min(doc.pages.length, to); i++) {
    const block = pageBlock(doc, i);
    if (used + block.length > budget) { truncated = true; break; }
    out.push(block);
    used += block.length;
  }
  return { text: out.join('\n\n'), truncated, lastPage: from - 1 + out.length };
}

const STOP = new Set(('de la que el en y a los del se las por un para con no una su al lo como mas más pero sus le ya o este si porque esta entre cuando muy sin sobre tambien también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mi antes algunos que qué unos yo otro otras otra el tanto esa estos mucho quienes nada muchos cual cuál poco ella estar estas algunas algo nosotros es son fue ser era cómo como explica explícame dime puedes quiero sobre tema the of and to in is that for on with as are this be it by or from an').split(' '));

function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function terms(s) {
  return norm(s).split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 3 && !STOP.has(w));
}

// Recuperación simple por palabras clave (TF-IDF) sobre las páginas.
export function relevantPages(doc, query, budget = RETRIEVAL_BUDGET) {
  const q = [...new Set(terms(query))];
  if (!doc._index) {
    doc._index = doc.pages.map((p) => {
      const tf = new Map();
      for (const w of terms(p)) tf.set(w, (tf.get(w) || 0) + 1);
      return tf;
    });
  }
  const N = doc.pages.length;
  const df = new Map(q.map((w) => [w, doc._index.filter((tf) => tf.has(w)).length]));
  const scored = doc._index.map((tf, i) => {
    let score = 0;
    for (const w of q) {
      const f = tf.get(w);
      if (f) score += (1 + Math.log(f)) * Math.log(1 + N / df.get(w));
    }
    return { i, score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);

  const chosen = new Set();
  let used = 0;
  const pick = (i) => {
    if (i < 0 || i >= N || chosen.has(i)) return;
    const len = doc.pages[i].length + 20;
    if (used + len > budget) return;
    chosen.add(i);
    used += len;
  };
  for (const { i } of scored.slice(0, 10)) pick(i);
  // Páginas vecinas de las mejores: las ideas suelen continuar en la página siguiente.
  for (const { i } of scored.slice(0, 3)) { pick(i + 1); pick(i - 1); }
  if (chosen.size === 0) for (let i = 0; i < Math.min(N, 6); i++) pick(i);

  return [...chosen].sort((a, b) => a - b);
}

export function contextFor(doc, query) {
  if (doc.chars <= FULL_DOC_CHARS) {
    return { full: true, text: doc.pages.map((_, i) => pageBlock(doc, i)).join('\n\n') };
  }
  const pages = relevantPages(doc, query);
  return { full: false, pages, text: pages.map((i) => pageBlock(doc, i)).join('\n\n') };
}
