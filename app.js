import { db, uid } from './js/db.js';
import { extractPdf, contextFor, rangeText, FULL_DOC_CHARS } from './js/docs.js';
import { streamChat, complete, parseJSON, formatCost } from './js/llm.js';
import { newCard, schedule, label, isDue } from './js/srs.js';
import * as P from './js/prompts.js';
import { renderDiagrams, checkDiagram, saveSvgAsPng } from './js/diagrams.js';

// ---------- Estado ----------

const DEFAULT_SETTINGS = {
  apiKey: '',
  chatModel: 'anthropic/claude-sonnet-5.5',
  genModel: 'anthropic/claude-sonnet-5.5',
  profile: 'Estudio psicología. Prefiero explicaciones paso a paso, con analogías y ejemplos concretos de la vida diaria. Me ayuda ver cómo se conectan las ideas entre sí.',
};

const state = {
  settings: loadSettings(),
  docs: [],
  activeId: localGet('tutor.active'),
  tab: localGet('tutor.tab') || 'biblioteca',
  busy: false,
  quiz: null,
  gen: null,
  review: null,
  abort: null,
};

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* modo privado */ } }

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('tutor.settings') || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() { localSet('tutor.settings', JSON.stringify(state.settings)); }

const activeDoc = () => state.docs.find((d) => d.id === state.activeId) || null;

// ---------- Utilidades de interfaz ----------

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function md(text) {
  // Las citas se convierten en enlaces, salvo dentro de bloques de código (ahí rompería los diagramas).
  const linked = String(text || '').split(/(```[\s\S]*?(?:```|$))/).map((part, i) => (i % 2 ? part : part.replace(
    /\[(?:p|pág|pag|página|pagina)\.?\s*(\d+)((?:\s*[,–-]\s*\d+)*)\]/gi,
    (_, first, rest) => `[p. ${first}${rest.replace(/\s+/g, '')}](#p${first})`,
  ))).join('');
  const html = DOMPurify.sanitize(marked.parse(linked));
  return html.replace(/<a href="#p(\d+)">/g, '<a class="cite" href="#p$1">');
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function openSheet(title, html, { markdown = false } = {}) {
  $('#sheetTitle').textContent = title;
  const body = $('#sheetBody');
  body.className = 'sheet-body' + (markdown ? ' md' : '');
  body.innerHTML = html;
  $('#sheet').showModal();
  return body;
}
$('#sheetClose').onclick = () => $('#sheet').close();
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') $('#sheet').close(); });

// Botones de cada diagrama: ampliar y guardar como imagen.
document.addEventListener('click', (e) => {
  const zoom = e.target.closest('[data-diagram-zoom]');
  const save = e.target.closest('[data-diagram-save]');
  if (!zoom && !save) return;
  const svg = e.target.closest('.diagram')?.querySelector('svg');
  if (!svg) return;
  if (save) {
    saveSvgAsPng(svg, activeDoc()?.name ? `Diagrama ${activeDoc().name}` : 'diagrama').catch(() => toast('No pude guardar la imagen.'));
    return;
  }
  const body = openSheet('Diagrama', '<div class="diagram-zoom"></div><p class="small muted">Desliza para recorrerlo. Gira el celular para verlo más grande.</p>');
  body.style.whiteSpace = 'normal';
  const copy = svg.cloneNode(true);
  copy.removeAttribute('style');
  const w = svg.viewBox?.baseVal?.width;
  if (w) copy.setAttribute('width', Math.max(w, 640));
  body.querySelector('.diagram-zoom').appendChild(copy);
});

// Al tocar una cita [p. N] se muestra el texto de esa página.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a.cite');
  if (!a) return;
  e.preventDefault();
  const doc = activeDoc();
  const n = Number(a.getAttribute('href').slice(2));
  if (!doc || !doc.pages[n - 1]) return toast('No encuentro esa página en el documento.');
  openSheet(`${doc.name} · página ${n}`, esc(doc.pages[n - 1]) || '<span class="muted">Esta página no tiene texto legible.</span>');
});

function needDoc() {
  if (activeDoc()) return false;
  view.innerHTML = `
    <div class="card hero stack">
      <h1>Primero, un documento</h1>
      <p>Sube un PDF en la Biblioteca y elígelo como documento activo.</p>
      <button class="btn-primary" data-go="biblioteca">Ir a la Biblioteca</button>
    </div>`;
  return true;
}
view.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) setTab(go.dataset.go);
});

function needKeyNotice() {
  return state.settings.apiKey ? '' : `
    <div class="card notice"><strong>Falta tu clave de OpenRouter.</strong>
    <p class="small">La IA no puede responder sin ella. <button class="btn-ghost small" data-open-settings>Agregarla en Ajustes</button></p></div>`;
}
view.addEventListener('click', (e) => { if (e.target.closest('[data-open-settings]')) openSettings(); });

// ---------- Navegación ----------

function setTab(tab) {
  if (state.abort) { state.abort.abort(); state.abort = null; }
  state.tab = tab;
  localSet('tutor.tab', tab);
  document.querySelectorAll('.tabs button').forEach((b) => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  render();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });

function render() {
  ({ biblioteca: renderLibrary, tutor: () => renderChat('tutor'), feynman: () => renderChat('feynman'), preguntas: renderQuestions, repaso: renderReview }[state.tab] || renderLibrary)();
}

function renderDocSelect() {
  const sel = $('#docSelect');
  sel.innerHTML = state.docs.length
    ? state.docs.map((d) => `<option value="${d.id}" ${d.id === state.activeId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')
    : '<option value="">Sin documentos</option>';
  sel.disabled = !state.docs.length;
}
$('#docSelect').onchange = (e) => setActive(e.target.value);

function setActive(id) {
  state.activeId = id;
  localSet('tutor.active', id);
  state.quiz = null;
  state.gen = null;
  renderDocSelect();
  render();
}

async function refreshDueBadge() {
  const cards = await db.all('cards');
  const n = cards.filter((c) => isDue(c)).length;
  const b = $('#dueBadge');
  b.hidden = n === 0;
  b.textContent = n;
  return { cards, n };
}

// ---------- Biblioteca ----------

async function renderLibrary() {
  const { cards } = await refreshDueBadge();
  const dueByDoc = {};
  const totalByDoc = {};
  for (const c of cards) {
    totalByDoc[c.docId] = (totalByDoc[c.docId] || 0) + 1;
    if (isDue(c)) dueByDoc[c.docId] = (dueByDoc[c.docId] || 0) + 1;
  }
  const due = cards.filter((c) => isDue(c)).length;

  view.innerHTML = `
    ${needKeyNotice()}
    ${due ? `<div class="card hero row"><div class="grow"><strong>Tienes ${due} tarjeta${due === 1 ? '' : 's'} para repasar hoy.</strong><br><span class="small muted">Repasar primero consolida lo de días anteriores.</span></div><button class="btn-primary" data-go="repaso">Repasar</button></div>` : ''}
    <h1>Biblioteca</h1>
    <div class="card stack">
      <label for="pdfInput">Subir PDF</label>
      <input id="pdfInput" type="file" accept="application/pdf,.pdf" multiple>
      <div id="uploadStatus" class="small muted">El PDF se lee en tu dispositivo. A la IA solo se envía el texto cuando le preguntas algo.</div>
    </div>
    <div id="docList">
      ${state.docs.length ? state.docs.map((d) => `
        <div class="card doc-item ${d.id === state.activeId ? 'active' : ''}">
          <div class="grow">
            <div class="name">${esc(d.name)}</div>
            <div class="small muted">${d.pages.length} páginas · ${totalByDoc[d.id] || 0} tarjetas${dueByDoc[d.id] ? ` · <strong>${dueByDoc[d.id]} para hoy</strong>` : ''}${d.chars > FULL_DOC_CHARS ? ' · documento largo: la IA lee las páginas relacionadas con cada pregunta' : ''}</div>
            ${d.looksScanned ? '<div class="small" style="color:var(--warn)">Parece un PDF escaneado: casi no tiene texto legible. Usa una versión con texto seleccionable.</div>' : ''}
          </div>
          ${d.id === state.activeId ? '<span class="small muted">Activo</span>' : `<button data-activate="${d.id}">Usar</button>`}
          <button class="icon-btn btn-danger" data-delete="${d.id}" aria-label="Eliminar ${esc(d.name)}" title="Eliminar">🗑</button>
        </div>`).join('') : '<p class="muted">Aún no has subido documentos.</p>'}
    </div>
    <h2>Cómo usar el Tutor para recordar más</h2>
    <div class="card small">
      <ol>
        <li><strong>Tutor:</strong> pregunta lo que no entiendas. Toca las citas <a class="cite" href="#p1">p. 1</a> para ver el texto original.</li>
        <li><strong>Explícalo:</strong> cuéntale el tema con tus palabras. Te dirá qué te falta (técnica Feynman).</li>
        <li><strong>Preguntas:</strong> responde sin mirar el texto. Recordar con esfuerzo fija más que releer.</li>
        <li><strong>Repaso:</strong> 10 a 15 minutos al día. Las tarjetas vuelven justo cuando estás por olvidarlas.</li>
      </ol>
    </div>`;

  $('#pdfInput').onchange = (e) => handleUpload([...e.target.files]);
  view.querySelectorAll('[data-activate]').forEach((b) => { b.onclick = () => setActive(b.dataset.activate); });
  view.querySelectorAll('[data-delete]').forEach((b) => {
    b.onclick = async () => {
      const d = state.docs.find((x) => x.id === b.dataset.delete);
      if (!confirm(`¿Eliminar "${d.name}" con sus tarjetas y conversaciones? No se puede deshacer.`)) return;
      await db.deleteDoc(d.id);
      state.docs = state.docs.filter((x) => x.id !== d.id);
      if (state.activeId === d.id) state.activeId = state.docs[0]?.id || null;
      localSet('tutor.active', state.activeId || '');
      renderDocSelect();
      renderLibrary();
    };
  });
}

async function handleUpload(files) {
  const status = $('#uploadStatus');
  for (const file of files) {
    status.innerHTML = `Leyendo <strong>${esc(file.name)}</strong>… <div class="progress"><div id="bar"></div></div>`;
    try {
      const { pages, chars, looksScanned } = await extractPdf(file, (p) => { const bar = $('#bar'); if (bar) bar.style.width = `${Math.round(p * 100)}%`; });
      const doc = { id: uid(), name: file.name.replace(/\.pdf$/i, ''), pages, chars, looksScanned, createdAt: Date.now() };
      await db.put('docs', doc);
      state.docs.unshift(doc);
      state.activeId = doc.id;
      localSet('tutor.active', doc.id);
      toast(looksScanned ? 'Subido, pero parece escaneado: tiene muy poco texto.' : `Listo: ${pages.length} páginas.`);
    } catch (err) {
      console.error(err);
      toast(`No pude leer ${file.name}: ${err.message}`);
    }
  }
  renderDocSelect();
  renderLibrary();
}

// ---------- Tutor y Feynman (chat) ----------

const CHAT_INFO = {
  tutor: {
    title: 'Tutor',
    intro: 'Pregúntale lo que no entiendas. Responde con base en tu PDF y cita las páginas.',
    placeholder: 'Ej.: ¿Qué diferencia hay entre memoria de trabajo y memoria a corto plazo?',
    chips: ['Explícamelo más simple', 'Hazme un diagrama de este tema', 'Dame un ejemplo de la vida diaria', 'Hazme una pregunta para ver si entendí', '¿Cómo se conecta esto con lo anterior?', 'Resume este documento en 5 ideas clave'],
    system: P.tutorSystem,
  },
  feynman: {
    title: 'Explícalo con tus palabras',
    intro: 'Escribe (o dicta con el micrófono del teclado) lo que entiendes de un tema, como si se lo enseñaras a alguien. El Tutor te dirá qué está bien y qué te falta.',
    placeholder: 'Ej.: El condicionamiento operante es cuando…',
    chips: ['Elige tú un tema importante del documento para que yo lo explique', 'Dame la respuesta y luego la reformulo', 'Ponme un caso para aplicar lo que expliqué'],
    system: P.feynmanSystem,
  },
};

async function renderChat(mode) {
  if (needDoc()) return;
  const doc = activeDoc();
  const info = CHAT_INFO[mode];
  const chatId = `${doc.id}:${mode}`;
  const chat = (await db.get('chats', chatId)) || { id: chatId, docId: doc.id, mode, messages: [] };

  view.innerHTML = `
    ${needKeyNotice()}
    <div class="row"><h1 class="grow">${info.title}</h1>${chat.messages.length ? '<button class="btn-ghost small" id="clearChat">Nueva conversación</button>' : ''}</div>
    <p class="muted small">${info.intro}</p>
    <div class="chat" id="chat"></div>
    <div class="composer">
      <div class="chips">${info.chips.map((c) => `<button data-chip>${esc(c)}</button>`).join('')}</div>
      <div class="row">
        <textarea id="input" class="grow" rows="2" placeholder="${esc(info.placeholder)}"></textarea>
        <button class="btn-primary" id="send">Enviar</button>
      </div>
    </div>`;

  const list = $('#chat');
  const askFix = (error) => send(P.fixDiagramPrompt(error));
  const addBubble = (m) => {
    const div = document.createElement('div');
    div.className = `msg ${m.role}${m.error ? ' error' : ''}`;
    if (m.role === 'user') div.textContent = m.content;
    else {
      div.innerHTML = `<div class="md">${md(m.content)}</div>${m.meta ? `<div class="meta">${esc(m.meta)}</div>` : ''}`;
      if (m.content) renderDiagrams(div, { onFix: askFix });
    }
    list.appendChild(div);
    return div;
  };
  chat.messages.forEach(addBubble);
  if (chat.messages.length) setTimeout(() => list.lastElementChild?.scrollIntoView({ block: 'end' }), 0);

  const input = $('#input');
  const send = async (text) => {
    text = text.trim();
    if (!text || state.busy) return;
    state.busy = true;
    $('#send').disabled = true;
    input.value = '';
    const userMsg = { role: 'user', content: text };
    chat.messages.push(userMsg);
    addBubble(userMsg);

    const bubble = addBubble({ role: 'assistant', content: '' });
    const content = bubble.querySelector('.md');
    content.classList.add('typing');
    bubble.scrollIntoView({ block: 'end' });

    const recent = chat.messages.slice(-16);
    const query = chat.messages.filter((m) => m.role === 'user').slice(-3).map((m) => m.content).join(' ');
    const ctx = contextFor(doc, query);
    const model = state.settings.chatModel;
    const messages = [
      P.systemMessage(model, info.system(doc, state.settings.profile, ctx), ctx.text, ctx.full),
      ...recent.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })),
    ];

    state.abort = new AbortController();
    try {
      let lastPaint = 0;
      const { text: answer, usage } = await streamChat({
        apiKey: state.settings.apiKey, model, messages, signal: state.abort.signal,
        onDelta: (t) => {
          const now = performance.now();
          if (now - lastPaint > 60) { content.innerHTML = md(t); renderDiagrams(content, { pending: true }); lastPaint = now; }
        },
      });
      content.classList.remove('typing');
      content.innerHTML = md(answer);
      renderDiagrams(content, { onFix: askFix });
      const meta = [formatCost(usage), ctx.full ? '' : `leyó las páginas ${ctx.pages.map((i) => i + 1).join(', ')}`].filter(Boolean).join(' · ');
      if (meta) bubble.insertAdjacentHTML('beforeend', `<div class="meta">${esc(meta)}</div>`);
      chat.messages.push({ role: 'assistant', content: answer, meta });
      await db.put('chats', chat);
    } catch (err) {
      content.classList.remove('typing');
      if (err.name === 'AbortError') return;
      bubble.classList.add('error');
      content.textContent = err.message;
      chat.messages.push({ role: 'assistant', content: err.message, error: true });
    } finally {
      state.busy = false;
      state.abort = null;
      const btn = $('#send');
      if (btn) btn.disabled = false;
    }
  };

  $('#send').onclick = () => send(input.value);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 900px)').matches) { e.preventDefault(); send(input.value); }
  });
  view.querySelectorAll('[data-chip]').forEach((b) => { b.onclick = () => send(b.textContent); });
  const clear = $('#clearChat');
  if (clear) clear.onclick = async () => {
    if (!confirm('¿Empezar una conversación nueva? La actual se borrará.')) return;
    await db.del('chats', chatId);
    renderChat(mode);
  };
}

// ---------- Preguntas y creación de tarjetas ----------

function rangeControls(doc, prefix) {
  const last = doc.pages.length;
  return `
    <div class="row">
      <span>Páginas</span>
      <input type="number" id="${prefix}From" min="1" max="${last}" value="1" aria-label="Desde la página">
      <span>a</span>
      <input type="number" id="${prefix}To" min="1" max="${last}" value="${Math.min(last, 20)}" aria-label="Hasta la página">
      <span class="muted small">de ${last}</span>
    </div>`;
}

function readRange(prefix, doc) {
  let from = Number($(`#${prefix}From`).value) || 1;
  let to = Number($(`#${prefix}To`).value) || doc.pages.length;
  from = Math.min(Math.max(1, from), doc.pages.length);
  to = Math.min(Math.max(from, to), doc.pages.length);
  return { from, to };
}

async function renderQuestions() {
  if (needDoc()) return;
  const doc = activeDoc();
  if (state.quiz && state.quiz.docId === doc.id) return renderQuiz();
  if (state.gen && state.gen.docId === doc.id) return renderGenerated();
  if (state.map && state.map.docId === doc.id) return renderMap();
  const saved = (await db.get('chats', `${doc.id}:maps`))?.maps || [];

  view.innerHTML = `
    ${needKeyNotice()}
    <h1>Practicar</h1>
    <p class="muted small">Responder sin mirar el texto cuesta más que releer, y por eso funciona: ese esfuerzo de recordar es lo que fija la información.</p>
    <div class="card stack">
      <h2 style="margin-top:0">Mapa del tema</h2>
      <p class="small muted">Un mapa conceptual de las páginas que elijas: los conceptos centrales y cómo se relacionan.</p>
      ${rangeControls(doc, 'm')}
      <button class="btn-primary" id="startMap">Crear mapa</button>
      ${saved.length ? `<div class="stack">${saved.map((m, i) => `
        <div class="row small"><span class="grow">🗺️ ${esc(m.title)} <span class="muted">(p. ${m.from}–${m.to})</span></span>
          <button class="small" data-open-map="${i}">Ver</button>
          <button class="icon-btn btn-danger" data-del-map="${i}" aria-label="Eliminar mapa" title="Eliminar">🗑</button></div>`).join('')}</div>` : ''}
    </div>
    <div class="card stack">
      <h2 style="margin-top:0">Practicar con preguntas</h2>
      <p class="small muted">Respondes por escrito y el Tutor te corrige con base en el PDF.</p>
      ${rangeControls(doc, 'q')}
      <div class="row"><span>Cantidad</span><input type="number" id="qN" min="3" max="15" value="5"></div>
      <button class="btn-primary" id="startQuiz">Generar preguntas</button>
    </div>
    <div class="card stack">
      <h2 style="margin-top:0">Crear tarjetas de repaso</h2>
      <p class="small muted">El Tutor propone tarjetas de una idea cada una. Tú eliges cuáles guardar.</p>
      ${rangeControls(doc, 'c')}
      <div class="row"><span>Cantidad</span><input type="number" id="cN" min="3" max="25" value="10"></div>
      <button class="btn-primary" id="startCards">Proponer tarjetas</button>
    </div>
    <div id="genStatus" class="small muted"></div>`;

  $('#startMap').onclick = () => generateMap();
  view.querySelectorAll('[data-open-map]').forEach((b) => { b.onclick = () => { state.map = { ...saved[b.dataset.openMap], docId: doc.id, saved: true }; renderMap(); }; });
  view.querySelectorAll('[data-del-map]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('¿Eliminar este mapa?')) return;
      saved.splice(Number(b.dataset.delMap), 1);
      await db.put('chats', { id: `${doc.id}:maps`, docId: doc.id, mode: 'maps', maps: saved });
      renderQuestions();
    };
  });
  $('#startQuiz').onclick = () => generate('quiz');
  $('#startCards').onclick = () => generate('cards');
}

async function generate(kind) {
  if (state.busy) return;
  const doc = activeDoc();
  const prefix = kind === 'quiz' ? 'q' : 'c';
  const { from, to } = readRange(prefix, doc);
  const n = Math.min(25, Math.max(3, Number($(`#${prefix}N`).value) || 5));
  const range = rangeText(doc, from, to);
  if (!range.text.trim()) return toast('Esas páginas no tienen texto legible.');

  const status = $('#genStatus');
  status.textContent = kind === 'quiz' ? 'Preparando preguntas…' : 'Preparando tarjetas…';
  if (range.truncated) toast(`Es mucho texto: usaré de la página ${from} a la ${range.lastPage}.`);
  state.busy = true;
  view.querySelectorAll('button').forEach((b) => { b.disabled = true; });

  const model = state.settings.genModel;
  try {
    const { text } = await complete({
      apiKey: state.settings.apiKey, model,
      messages: [
        P.systemMessage(model, 'Eres un experto en diseño de material de estudio basado en evidencia. Responde siempre en español.', range.text, false),
        { role: 'user', content: kind === 'quiz' ? P.questionsPrompt(n) : P.cardsPrompt(n) },
      ],
    });
    const items = parseJSON(text);
    if (!Array.isArray(items) || !items.length) throw new Error('No recibí preguntas o tarjetas.');
    if (kind === 'quiz') {
      state.quiz = { docId: doc.id, from, to: range.lastPage, idx: 0, items: items.map((q) => ({ pregunta: q.pregunta, pagina: q.pagina })) };
    } else {
      state.gen = { docId: doc.id, items: items.map((c) => ({ frente: c.frente, reverso: c.reverso, pagina: c.pagina, keep: true })) };
    }
  } catch (err) {
    console.error(err);
    toast(err.message);
  } finally {
    state.busy = false;
    renderQuestions();
  }
}

async function generateMap() {
  if (state.busy) return;
  const doc = activeDoc();
  const { from, to } = readRange('m', doc);
  const range = rangeText(doc, from, to);
  if (!range.text.trim()) return toast('Esas páginas no tienen texto legible.');
  if (range.truncated) toast(`Es mucho texto: usaré de la página ${from} a la ${range.lastPage}.`);

  state.busy = true;
  view.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  $('#genStatus').innerHTML = '<span class="typing">Dibujando el mapa</span>';
  const model = state.settings.genModel;
  const messages = [
    P.systemMessage(model, 'Eres un experto en organizar conocimiento para estudiar. Responde siempre en español.', range.text, false),
    { role: 'user', content: P.mapPrompt() },
  ];
  try {
    let text = '';
    // Si el diagrama sale con errores de sintaxis, se le pide una vez al modelo que lo corrija.
    for (let attempt = 0; attempt < 2; attempt++) {
      ({ text } = await complete({ apiKey: state.settings.apiKey, model, messages }));
      const code = text.match(/```mermaid\s*([\s\S]*?)```/)?.[1];
      const error = code ? await checkDiagram(code.trim()) : 'No incluiste un bloque mermaid.';
      if (!error) break;
      if (attempt === 1) throw new Error('El modelo no logró dibujar un mapa válido. Intenta con menos páginas.');
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: P.fixDiagramPrompt(error) });
    }
    const title = text.match(/T[ÍI]TULO:\s*(.+)/i)?.[1]?.replace(/[*_#]/g, '').trim() || `Páginas ${from} a ${range.lastPage}`;
    state.map = { docId: doc.id, title, text: text.replace(/^.*T[ÍI]TULO:.*$/im, '').trim(), from, to: range.lastPage, createdAt: Date.now() };
  } catch (err) {
    console.error(err);
    toast(err.message);
  } finally {
    state.busy = false;
    renderQuestions();
  }
}

function renderMap() {
  const m = state.map;
  view.innerHTML = `
    <div class="row"><h1 class="grow">${esc(m.title)}</h1><button class="btn-ghost small" id="exitMap">Volver</button></div>
    <p class="small muted">Páginas ${m.from} a ${m.to}</p>
    <div class="card md" id="mapBody">${md(m.text)}</div>
    <div class="row">
      ${m.saved ? '' : '<button class="btn-primary" id="saveMap">Guardar en mis mapas</button>'}
      <button id="quizMap">Modo reto: ocultar relaciones</button>
    </div>
    <p class="small muted">Para recordar más: oculta las relaciones e intenta decir en voz alta cómo se conecta cada concepto antes de volver a mostrarlas. Mirar el mapa ayuda a entender; recordarlo sin mirar es lo que fija la información.</p>`;
  const body = $('#mapBody');
  renderDiagrams(body);
  $('#exitMap').onclick = () => { state.map = null; renderQuestions(); };
  $('#quizMap').onclick = (e) => {
    const on = body.classList.toggle('hide-relations');
    e.target.textContent = on ? 'Mostrar relaciones' : 'Modo reto: ocultar relaciones';
  };
  const save = $('#saveMap');
  if (save) save.onclick = async () => {
    const id = `${m.docId}:maps`;
    const rec = (await db.get('chats', id)) || { id, docId: m.docId, mode: 'maps', maps: [] };
    rec.maps.unshift({ title: m.title, text: m.text, from: m.from, to: m.to, createdAt: m.createdAt });
    await db.put('chats', rec);
    m.saved = true;
    toast('Mapa guardado.');
    renderMap();
  };
}

function renderQuiz() {
  const doc = activeDoc();
  const quiz = state.quiz;
  const q = quiz.items[quiz.idx];
  const done = quiz.items.filter((x) => x.result).length;

  view.innerHTML = `
    <div class="row"><h1 class="grow">Pregunta ${quiz.idx + 1} de ${quiz.items.length}</h1><button class="btn-ghost small" id="exitQuiz">Salir</button></div>
    <div class="progress" style="margin-bottom:12px"><div style="width:${(done / quiz.items.length) * 100}%"></div></div>
    <div class="card stack">
      <div class="flash"><div class="front">${esc(q.pregunta)}</div></div>
      ${q.result ? '' : `
        <label for="answer">Tu respuesta (sin mirar el texto)</label>
        <textarea id="answer" placeholder="Escribe lo que recuerdes, aunque no estés seguro.">${esc(q.answer || '')}</textarea>
        <div class="row"><button class="btn-primary" id="check">Revisar</button><button class="btn-ghost" id="dontKnow">No lo sé</button></div>`}
      <div id="result"></div>
    </div>
    <div class="row">
      <button id="prevQ" ${quiz.idx === 0 ? 'disabled' : ''}>← Anterior</button>
      <span class="grow"></span>
      <button id="nextQ" ${quiz.idx === quiz.items.length - 1 ? 'disabled' : ''}>Siguiente →</button>
    </div>
    ${done === quiz.items.length ? `<div class="card hero"><strong>Terminaste.</strong> ${quiz.items.filter((x) => x.result?.nivel === 'correcta').length} correctas de ${quiz.items.length}. Guarda como tarjeta las que fallaste para repasarlas en los próximos días.</div>` : ''}`;

  if (q.result) showResult(q);
  $('#exitQuiz').onclick = () => { state.quiz = null; renderQuestions(); };
  $('#prevQ').onclick = () => { quiz.idx--; renderQuiz(); };
  $('#nextQ').onclick = () => { quiz.idx++; renderQuiz(); };
  const check = $('#check');
  if (check) {
    const grade = async (answer) => {
      if (state.busy) return;
      q.answer = answer;
      state.busy = true;
      check.disabled = true;
      $('#result').innerHTML = '<p class="muted typing">Revisando</p>';
      const range = rangeText(doc, quiz.from, quiz.to);
      const model = state.settings.genModel;
      try {
        const { text } = await complete({
          apiKey: state.settings.apiKey, model,
          messages: [
            P.systemMessage(model, 'Eres un profesor justo y claro que corrige respuestas de estudio. Responde siempre en español.', range.text, true),
            { role: 'user', content: P.gradePrompt(q.pregunta, answer) },
          ],
        });
        q.result = parseJSON(text);
      } catch (err) {
        toast(err.message);
      } finally {
        state.busy = false;
        renderQuiz();
      }
    };
    check.onclick = () => grade($('#answer').value.trim());
    $('#dontKnow').onclick = () => grade('');
  }
}

function showResult(q) {
  const r = q.result;
  const nivel = ['correcta', 'parcial', 'incorrecta'].includes(r.nivel) ? r.nivel : 'parcial';
  $('#result').innerHTML = `
    ${q.answer ? `<p class="small muted">Tu respuesta: ${esc(q.answer)}</p>` : ''}
    <p class="verdict ${nivel}">${{ correcta: '✓ Correcta', parcial: '◐ Parcialmente correcta', incorrecta: '✗ Incorrecta' }[nivel]}</p>
    <div class="md">${md(r.retroalimentacion)}</div>
    <p><strong>Respuesta ideal:</strong></p>
    <div class="md">${md(r.respuesta_ideal + (r.pagina ? ` [p. ${r.pagina}]` : ''))}</div>
    <button id="saveCard" ${q.saved ? 'disabled' : ''}>${q.saved ? 'Guardada ✓' : 'Guardar como tarjeta'}</button>`;
  $('#saveCard').onclick = async () => {
    await db.put('cards', newCard({ id: uid(), docId: state.quiz.docId, front: q.pregunta, back: r.respuesta_ideal, page: r.pagina }));
    q.saved = true;
    toast('Tarjeta guardada. Aparecerá en Repaso.');
    refreshDueBadge();
    showResult(q);
  };
}

function renderGenerated() {
  const gen = state.gen;
  const kept = gen.items.filter((c) => c.keep).length;
  view.innerHTML = `
    <div class="row"><h1 class="grow">Tarjetas propuestas</h1><button class="btn-ghost small" id="discard">Descartar</button></div>
    <p class="muted small">Desmarca las que no te sirvan. Puedes editar el texto antes de guardar.</p>
    ${gen.items.map((c, i) => `
      <div class="card gen-card">
        <input type="checkbox" data-keep="${i}" ${c.keep ? 'checked' : ''} aria-label="Guardar tarjeta ${i + 1}">
        <div class="grow stack">
          <textarea data-front="${i}" rows="2" aria-label="Frente">${esc(c.frente)}</textarea>
          <textarea data-back="${i}" rows="3" aria-label="Reverso">${esc(c.reverso)}</textarea>
          ${c.pagina ? `<span class="small muted">Página ${esc(c.pagina)}</span>` : ''}
        </div>
      </div>`).join('')}
    <button class="btn-primary" id="saveCards">Guardar ${kept} tarjeta${kept === 1 ? '' : 's'}</button>`;

  view.querySelectorAll('[data-keep]').forEach((cb) => { cb.onchange = () => { gen.items[cb.dataset.keep].keep = cb.checked; renderGenerated(); }; });
  view.querySelectorAll('[data-front]').forEach((t) => { t.oninput = () => { gen.items[t.dataset.front].frente = t.value; }; });
  view.querySelectorAll('[data-back]').forEach((t) => { t.oninput = () => { gen.items[t.dataset.back].reverso = t.value; }; });
  $('#discard').onclick = () => { state.gen = null; renderQuestions(); };
  $('#saveCards').onclick = async () => {
    const cards = gen.items.filter((c) => c.keep && c.frente?.trim() && c.reverso?.trim())
      .map((c) => newCard({ id: uid(), docId: gen.docId, front: c.frente.trim(), back: c.reverso.trim(), page: Number(c.pagina) || null }));
    await db.putMany('cards', cards);
    state.gen = null;
    toast(`${cards.length} tarjetas guardadas. Empieza a repasarlas hoy.`);
    refreshDueBadge();
    renderQuestions();
  };
}

// ---------- Repaso espaciado ----------

async function renderReview() {
  const { cards } = await refreshDueBadge();
  const r = state.review;
  if (r && r.queue.length) return renderReviewCard();

  const scope = localGet('tutor.reviewScope') || 'all';
  const pool = scope === 'doc' && state.activeId ? cards.filter((c) => c.docId === state.activeId) : cards;
  const due = pool.filter((c) => isDue(c)).sort((a, b) => a.due - b.due);
  const next = pool.filter((c) => !isDue(c)).sort((a, b) => a.due - b.due)[0];
  const reviewed = r?.reviewed || 0;

  view.innerHTML = `
    <h1>Repaso</h1>
    <div class="row small" style="margin-bottom:12px">
      <label style="margin:0"><input type="radio" name="scope" value="all" ${scope === 'all' ? 'checked' : ''} style="width:auto;min-height:0"> Todos los documentos</label>
      <label style="margin:0"><input type="radio" name="scope" value="doc" ${scope === 'doc' ? 'checked' : ''} style="width:auto;min-height:0"> Solo el activo</label>
    </div>
    ${reviewed ? `<div class="card hero"><strong>¡Bien!</strong> Repasaste ${reviewed} tarjeta${reviewed === 1 ? '' : 's'}.</div>` : ''}
    <div class="card stack">
      ${due.length
        ? `<p><strong>${due.length}</strong> tarjeta${due.length === 1 ? '' : 's'} para hoy.</p><button class="btn-primary" id="startReview">Empezar repaso</button>`
        : `<p>No tienes tarjetas pendientes${next ? `. La próxima vuelve el ${new Date(next.due).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' })}` : ''}.</p>
           ${pool.length ? '' : '<p class="small muted">Crea tarjetas en la sección Preguntas.</p>'}`}
    </div>
    <p class="small muted">Antes de mostrar la respuesta, intenta recordarla de verdad (puedes decirla en voz alta). Luego califica con honestidad: así el sistema sabe cuándo volver a mostrártela.</p>
    ${pool.length ? `<button class="btn-ghost" id="browse">Ver todas las tarjetas (${pool.length})</button>` : ''}`;

  view.querySelectorAll('input[name="scope"]').forEach((rb) => { rb.onchange = () => { localSet('tutor.reviewScope', rb.value); state.review = null; renderReview(); }; });
  const start = $('#startReview');
  if (start) start.onclick = () => { state.review = { queue: due, showBack: false, reviewed: 0 }; renderReviewCard(); };
  const browse = $('#browse');
  if (browse) browse.onclick = () => browseCards(pool);
}

function renderReviewCard() {
  const r = state.review;
  const card = r.queue[0];
  const doc = state.docs.find((d) => d.id === card.docId);
  view.innerHTML = `
    <div class="row"><h1 class="grow">Repaso</h1><span class="muted small">Quedan ${r.queue.length}</span><button class="btn-ghost small" id="stopReview">Terminar</button></div>
    <div class="card flash">
      <div class="small muted">${esc(doc?.name || 'Documento eliminado')}</div>
      <div class="front">${esc(card.front)}</div>
      ${r.showBack ? `<div class="back md">${md(card.back + (card.page ? ` [p. ${card.page}]` : ''))}</div>` : ''}
    </div>
    ${r.showBack
      ? `<p class="small muted" style="text-align:center">¿Qué tan bien lo recordaste?</p>
         <div class="grades">
           ${['Otra vez', 'Difícil', 'Bien', 'Fácil'].map((t, g) => `<button data-g="${g}">${t}<small>${label(card, g)}</small></button>`).join('')}
         </div>`
      : '<button class="btn-primary" id="reveal" style="width:100%">Mostrar respuesta</button>'}`;

  $('#stopReview').onclick = () => { state.review = { queue: [], reviewed: r.reviewed }; renderReview(); };
  const reveal = $('#reveal');
  if (reveal) reveal.onclick = () => { r.showBack = true; renderReviewCard(); };
  view.querySelectorAll('[data-g]').forEach((b) => {
    b.onclick = async () => {
      const g = Number(b.dataset.g);
      const updated = schedule(card, g);
      await db.put('cards', updated);
      r.queue.shift();
      r.reviewed++;
      if (g === 0) r.queue.push(updated); // vuelve al final de esta misma sesión
      r.showBack = false;
      if (r.queue.length) renderReviewCard(); else renderReview();
      refreshDueBadge();
    };
  });
}

// Las citas de una tarjeta se resuelven contra el documento activo; al repasar, activamos el de la tarjeta.
document.addEventListener('click', (e) => {
  const a = e.target.closest('.flash a.cite');
  if (!a || !state.review?.queue?.[0]) return;
  const docId = state.review.queue[0].docId;
  if (docId !== state.activeId && state.docs.some((d) => d.id === docId)) {
    state.activeId = docId;
    localSet('tutor.active', docId);
    renderDocSelect();
  }
}, true);

function browseCards(pool) {
  const body = openSheet(`Tarjetas (${pool.length})`, pool.sort((a, b) => a.due - b.due).map((c) => `
    <div class="card" data-card="${c.id}" style="white-space:normal">
      <strong>${esc(c.front)}</strong>
      <p class="small">${esc(c.back)}</p>
      <div class="row small muted"><span class="grow">Próximo repaso: ${new Date(c.due).toLocaleDateString('es')}${c.lapses ? ` · olvidada ${c.lapses} vez/veces` : ''}</span>
      <button class="btn-danger small" data-del-card="${c.id}">Eliminar</button></div>
    </div>`).join(''));
  body.querySelectorAll('[data-del-card]').forEach((b) => {
    b.onclick = async () => {
      await db.del('cards', b.dataset.delCard);
      body.querySelector(`[data-card="${b.dataset.delCard}"]`).remove();
      refreshDueBadge();
      if (state.tab === 'repaso') renderReview();
    };
  });
}

// ---------- Ajustes ----------

const MODELS = [
  ['anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5 · equilibrio (recomendado)'],
  ['anthropic/claude-opus-5.5', 'Claude Opus 5.5 · más profundo, cuesta el doble'],
  ['anthropic/claude-haiku-5.5', 'Claude Haiku 5.5 · muy barato, menos fino'],
  ['google/gemini-3.8-flash', 'Gemini 3.8 Flash · rápido y económico'],
];

function modelOptions(selected) {
  const known = MODELS.some(([id]) => id === selected);
  return (known ? MODELS : [[selected, selected], ...MODELS]).map(([id, name]) => `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(name)}</option>`).join('');
}

function openSettings() {
  const s = state.settings;
  const body = openSheet('Ajustes', `
    <div class="stack" style="white-space:normal">
      <div>
        <label for="sKey">Clave de OpenRouter</label>
        <input id="sKey" type="password" autocomplete="off" value="${esc(s.apiKey)}" placeholder="sk-or-…">
        <p class="small muted">Créala en openrouter.ai → Keys, y ponle un límite de gasto. Se guarda solo en este dispositivo.</p>
      </div>
      <div>
        <label for="sChat">Modelo para conversar</label>
        <select id="sChat" style="width:100%">${modelOptions(s.chatModel)}</select>
      </div>
      <div>
        <label for="sGen">Modelo para preguntas y tarjetas</label>
        <select id="sGen" style="width:100%">${modelOptions(s.genModel)}</select>
      </div>
      <div>
        <label for="sProfile">Sobre ti (el Tutor lo usa para adaptar sus explicaciones)</label>
        <textarea id="sProfile">${esc(s.profile)}</textarea>
      </div>
      <button class="btn-primary" id="sSave">Guardar</button>
      <h2>Copia de seguridad</h2>
      <p class="small muted">Tus documentos y tarjetas viven solo en este navegador. Exporta una copia de vez en cuando, y úsala para pasar tus datos del computador al celular.</p>
      <div class="row">
        <button id="sExport">Exportar copia</button>
        <label class="btn" style="font-weight:400;margin:0">Importar copia<input id="sImport" type="file" accept="application/json,.json" hidden></label>
      </div>
      <p class="small muted" id="sStorage"></p>
    </div>`);

  body.querySelector('#sSave').onclick = () => {
    s.apiKey = body.querySelector('#sKey').value.trim();
    s.chatModel = body.querySelector('#sChat').value;
    s.genModel = body.querySelector('#sGen').value;
    s.profile = body.querySelector('#sProfile').value.trim();
    saveSettings();
    $('#sheet').close();
    toast('Ajustes guardados.');
    render();
  };
  body.querySelector('#sExport').onclick = async () => {
    const data = await db.exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tutor-copia-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  body.querySelector('#sImport').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await db.importAll(JSON.parse(await file.text()));
      await loadDocs();
      if (!activeDoc()) state.activeId = state.docs[0]?.id || null;
      renderDocSelect();
      $('#sheet').close();
      toast('Copia importada.');
      render();
    } catch (err) {
      toast(err.message);
    }
  };
  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then(({ usage }) => {
      const el = body.querySelector('#sStorage');
      if (el) el.textContent = `Espacio usado: ${(usage / 1048576).toFixed(1)} MB.`;
    });
  }
}
$('#settingsBtn').onclick = openSettings;

// ---------- Inicio ----------

async function loadDocs() {
  state.docs = (await db.all('docs')).sort((a, b) => b.createdAt - a.createdAt);
}

async function init() {
  // Pide al navegador que no borre los datos por falta de espacio (sobre todo en iPhone).
  navigator.storage?.persist?.().catch(() => {});
  await loadDocs();
  if (!activeDoc()) state.activeId = state.docs[0]?.id || null;
  renderDocSelect();
  setTab(state.tab);
  if (!state.settings.apiKey) setTimeout(openSettings, 300);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
