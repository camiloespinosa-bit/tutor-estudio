// Repaso espaciado: variante simplificada del algoritmo SM-2 (el que popularizó SuperMemo y usa Anki).
// Calificaciones: 0 = Otra vez, 1 = Difícil, 2 = Bien, 3 = Fácil.

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
// Restamos unas horas para que una tarjeta "para mañana" aparezca mañana aunque estudies más temprano.
const SLACK = 4 * 60 * MIN;

export function newCard({ id, docId, front, back, page }) {
  return { id, docId, front, back, page: page || null, ease: 2.5, interval: 0, reps: 0, lapses: 0, due: Date.now(), createdAt: Date.now() };
}

export function schedule(card, grade, now = Date.now()) {
  let { ease = 2.5, interval = 0, reps = 0, lapses = 0 } = card;

  if (grade === 0) {
    return { ...card, ease: Math.max(1.3, ease - 0.2), interval: 0, reps: 0, lapses: lapses + 1, due: now + 10 * MIN, lastReview: now };
  }

  if (grade === 1) {
    interval = reps === 0 ? 1 : Math.max(interval + 1, Math.round(interval * 1.2));
    ease = Math.max(1.3, ease - 0.15);
  } else if (grade === 2) {
    interval = reps === 0 ? 1 : reps === 1 ? 3 : Math.max(interval + 1, Math.round(interval * ease));
  } else {
    interval = reps === 0 ? 4 : Math.max(interval + 1, Math.round(interval * ease * 1.3));
    ease = ease + 0.15;
  }

  return { ...card, ease, interval, reps: reps + 1, lapses, due: now + interval * DAY - SLACK, lastReview: now };
}

export function label(card, grade) {
  const next = schedule(card, grade);
  if (grade === 0) return '10 min';
  const d = next.interval;
  if (d < 30) return d === 1 ? '1 día' : `${d} días`;
  const m = Math.round(d / 30);
  return m === 1 ? '1 mes' : `${m} meses`;
}

export function isDue(card, now = Date.now()) {
  return card.due <= now;
}
