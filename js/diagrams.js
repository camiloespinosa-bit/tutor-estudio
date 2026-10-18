// Diagramas: el modelo escribe un bloque ```mermaid y aquí se convierte en dibujo.
// La librería (3 MB) se carga solo la primera vez que aparece un diagrama.

let mermaidReady;
let seq = 0;
let queue = Promise.resolve();

function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/mermaid.min.js';
      s.onload = () => {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'neutral',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          // Etiquetas como texto SVG puro: así el diagrama se puede guardar como imagen.
          flowchart: { htmlLabels: false, useMaxWidth: true },
        });
        resolve(window.mermaid);
      };
      s.onerror = () => { mermaidReady = null; reject(new Error('No se pudo cargar el dibujador de diagramas.')); };
      document.head.appendChild(s);
    });
  }
  return mermaidReady;
}

// Devuelve null si el código es válido, o el mensaje de error.
export async function checkDiagram(src) {
  const m = await loadMermaid();
  try {
    await m.parse(src);
    return null;
  } catch (err) {
    return String(err?.message || err).slice(0, 400);
  }
}

const ACTIONS = `
  <div class="diagram-actions">
    <button class="small" data-diagram-zoom>Ampliar</button>
    <button class="small" data-diagram-save>Guardar imagen</button>
  </div>`;

// Reemplaza cada bloque mermaid de `root` por su dibujo.
// pending: la respuesta todavía está llegando, así que solo se muestra un aviso.
// onFix(error): si se pasa, aparece un botón para pedirle al modelo que corrija el diagrama.
export async function renderDiagrams(root, { pending = false, onFix } = {}) {
  const blocks = [...root.querySelectorAll('pre > code.language-mermaid')];
  for (const code of blocks) {
    let src = code.textContent.trim();
    // En pantallas angostas, los mapas horizontales se dibujan de arriba hacia abajo para que se puedan leer.
    if (innerWidth < 700) src = src.replace(/^(\s*(?:flowchart|graph))\s+LR\b/m, '$1 TD');
    const box = document.createElement('div');
    box.className = 'diagram';
    code.parentElement.replaceWith(box);
    if (pending) {
      box.innerHTML = '<p class="muted small typing">Dibujando diagrama</p>';
      continue;
    }
    box.innerHTML = '<p class="muted small typing">Dibujando diagrama</p>';
    const id = `dg${++seq}`;
    try {
      const error = await checkDiagram(src);
      if (error) throw new Error(error);
      // mermaid no admite dibujar dos diagramas a la vez: se ponen en fila.
      const job = queue.then(() => window.mermaid.render(id, src));
      queue = job.catch(() => {});
      const { svg } = await job;
      box.innerHTML = `<div class="diagram-svg">${svg}</div>${ACTIONS}`;
      // Que no se encoja hasta volverse ilegible: si no cabe, se desliza de lado.
      const el = box.querySelector('svg');
      const natural = el.viewBox?.baseVal?.width;
      if (natural) el.style.width = `${Math.max(Math.min(natural, box.clientWidth - 18), natural * 0.65)}px`;
      const frame = box.querySelector('.diagram-svg');
      frame.scrollLeft = (frame.scrollWidth - frame.clientWidth) / 2;
    } catch (err) {
      document.getElementById(`d${id}`)?.remove(); // mermaid deja un elemento de error suelto
      box.innerHTML = `<p class="small" style="color:var(--bad)">No pude dibujar este diagrama.</p>${onFix ? '<button class="small" data-fix>Pedir que lo corrija</button>' : ''}`;
      box.querySelector('[data-fix]')?.addEventListener('click', () => onFix(String(err.message || err)));
    }
  }
}

export async function saveSvgAsPng(svgEl, name = 'diagrama') {
  const clone = svgEl.cloneNode(true);
  const vb = svgEl.viewBox?.baseVal;
  const w = Math.ceil(vb?.width || svgEl.getBoundingClientRect().width);
  const h = Math.ceil(vb?.height || svgEl.getBoundingClientRect().height);
  clone.setAttribute('width', w);
  clone.setAttribute('height', h);
  clone.removeAttribute('style');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const xml = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  await img.decode();

  const scale = 2;
  const pad = 24;
  const canvas = document.createElement('canvas');
  canvas.width = (w + pad * 2) * scale;
  canvas.height = (h + pad * 2) * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, pad * scale, pad * scale, w * scale, h * scale);

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'diagrama'}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
