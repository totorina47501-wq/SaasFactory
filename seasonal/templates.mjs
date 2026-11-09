// Local, non-commercial demonstration templates. No network or payment provider.
export const noelMemoryIcons = Object.freeze(['🎄', '🎁', '⛄', '🔔', '🧣', '🍪', '⭐', '🕯️']);
export const noelMemorySeedBase = 20261225;
const nextPseudoRandom = (state) => ((state * 1664525) + 1013904223) >>> 0;
const shuffleWithSeed = (items, seed) => {
  let state = seed >>> 0;
  const values = [...items];
  for (let index = values.length - 1; index > 0; index -= 1) {
    state = nextPseudoRandom(state);
    const swapIndex = state % (index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
};
export function buildNoelMemoryDeck(round = 0) {
  if (!Number.isInteger(round) || round < 0 || round > 10_000) throw new Error('round must be a bounded positive integer.');
  const seed = noelMemorySeedBase + (round * 97);
  return shuffleWithSeed([...noelMemoryIcons, ...noelMemoryIcons], seed);
}

export const themes = Object.freeze({
  'promo-flash': Object.freeze({
    name: 'PromoFlash',
    domain: 'promo-flash.example',
    description: 'Calculez les réductions à partir des prix que vous saisissez.',
    page: String.raw`"use client";
import { useState } from 'react';

const euro = (amount: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(amount);
const numeric = (text: string) => text.trim() === '' ? NaN : Number(text.replace(',', '.'));

export default function Home() {
  const [reference, setReference] = useState('129.99');
  const [offered, setOffered] = useState('89.99');
  const original = numeric(reference);
  const price = numeric(offered);
  const valid = Number.isFinite(original) && Number.isFinite(price) && original > 0 && original <= 1000000 && price >= 0 && price <= 1000000;
  const savings = valid ? original - price : 0;
  const reduction = valid ? 100 * savings / original : 0;
  return (
    <main>
      <header><span className="eyebrow">BLACK FRIDAY 2026 · OUTIL GRATUIT</span><h1>PromoFlash<span>.</span></h1><p className="lead">Calculez une remise, sans compte et sans publicité.</p></header>
      <section className="panel" aria-labelledby="title"><h2 id="title">Estimez vos économies</h2><p>Saisissez deux prix observés. Aucune recherche automatique de promotions.</p>
        <div className="fields"><label htmlFor="reference">Prix de référence (€)<input id="reference" inputMode="decimal" type="text" value={reference} onChange={event => setReference(event.target.value)} /></label><label htmlFor="offered">Prix proposé (€)<input id="offered" inputMode="decimal" type="text" value={offered} onChange={event => setOffered(event.target.value)} /></label></div>
        {valid ? <div className="result" aria-live="polite"><span>Votre économie calculée</span><strong>{euro(savings)}</strong><b>{reduction.toFixed(1)} % {reduction >= 0 ? 'de réduction' : "d'augmentation"}</b></div> : <p role="alert" className="error">Saisissez des montants valides (prix initial positif).</p>}
      </section>
      <section className="note"><h2>À vérifier avant d'acheter</h2><p>Le calcul repose uniquement sur vos données. Le prix de référence n'est pas vérifié ; cet outil ne garantit ni la réalité d'une promotion ni le meilleur prix. Vérifiez le vendeur et les conditions de vente.</p></section>
      <footer>PromoFlash · Démonstration locale sans paiement, inscription ou suivi utilisateur.</footer>
    </main>
  );
}
`
  }),
  'cadeaux-zen': Object.freeze({
    name: 'CadeauxZen',
    domain: 'cadeaux-zen.example',
    description: 'Organisez votre budget cadeaux de fêtes sur un seul écran.',
    page: String.raw`"use client";
import { useState } from 'react';

const euro = (amount: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(amount);
type Gift = { id: number; name: string; amount: string };
const parsePrice = (value: string) => value.trim() === '' ? NaN : Number(value.replace(',', '.'));

export default function Home() {
  const [budget, setBudget] = useState('250');
  const [gifts, setGifts] = useState<Gift[]>([{ id: 1, name: 'Premier cadeau', amount: '45' }]);
  const limit = parsePrice(budget);
  const prices = gifts.map(gift => parsePrice(gift.amount));
  const valid = Number.isFinite(limit) && limit >= 0 && limit <= 1000000 && prices.every(price => Number.isFinite(price) && price >= 0 && price <= 1000000);
  const total = valid ? prices.reduce((sum, current) => sum + current, 0) : 0;
  const remaining = limit - total;
  const change = (id: number, key: 'name' | 'amount', value: string) => setGifts(items => items.map(item => item.id === id ? { ...item, [key]: value } : item));
  return (
    <main>
      <header><span className="eyebrow">NOËL 2026 · ORGANISATEUR GRATUIT</span><h1>CadeauxZen<span>.</span></h1><p className="lead">Offrez avec plaisir, sans dépasser votre budget.</p></header>
      <section className="panel" aria-labelledby="budget-title"><h2 id="budget-title">Mon budget cadeaux</h2><label htmlFor="budget">Budget total (€)<input id="budget" type="text" inputMode="decimal" value={budget} onChange={event => setBudget(event.target.value)} /></label>
        <h2>Mes idées cadeaux</h2>
        {gifts.map((gift, index) => <div className="gift" key={gift.id}><label>Pour qui ?<input aria-label={'Destinataire du cadeau ' + (index + 1)} value={gift.name} onChange={event => change(gift.id, 'name', event.target.value)} maxLength={70}/></label><label>Montant (€)<input aria-label={'Budget du cadeau ' + (index + 1)} inputMode="decimal" value={gift.amount} onChange={event => change(gift.id, 'amount', event.target.value)} /></label><button type="button" className="minor" onClick={() => setGifts(items => items.filter(item => item.id !== gift.id))} aria-label={'Retirer le cadeau ' + (index + 1)}>Retirer</button></div>)}
        <button type="button" onClick={() => setGifts(items => [...items, { id: (items.at(-1)?.id ?? 0) + 1, name: '', amount: '0' }])} disabled={gifts.length >= 30}>+ Ajouter un cadeau</button>
        {valid ? <div className="result" aria-live="polite"><span>Montant prévu : {euro(total)}</span><strong>{euro(remaining)}</strong><b>{remaining >= 0 ? 'de budget restant' : 'au-dessus du budget'}</b></div> : <p className="error" role="alert">Vérifiez les montants saisis (de 0 à 1 000 000 €).</p>}
      </section>
      <section className="note"><h2>Votre confidentialité</h2><p>Les données restent dans cette page pendant la session. Elles ne sont ni envoyées à un serveur, ni sauvegardées dans un compte : conservez vos notes avant de fermer la page.</p></section>
      <footer>CadeauxZen · Démonstration locale, sans paiement, compte ou suivi utilisateur.</footer>
    </main>
  );
}
`
  }),
  'noel-memory': Object.freeze({
    name: 'Noël Memory',
    domain: 'noel-memory.example',
    description: 'Jeu de Memory de Noël mobile-first, jouable au clavier et au toucher.',
    page: String.raw`"use client";
import { useEffect, useMemo, useRef, useState } from 'react';

type Card = { id: number; value: string; matched: boolean };

const ICONS = ['🎄', '🎁', '⛄', '🔔', '🧣', '🍪', '⭐', '🕯️'];
const MEMORY_SEED_BASE = 20261225;
const nextPseudoRandom = (state: number) => ((state * 1664525) + 1013904223) >>> 0;
const shuffleWithSeed = (items: string[], seed: number) => {
  let state = seed >>> 0;
  const values = [...items];
  for (let index = values.length - 1; index > 0; index -= 1) {
    state = nextPseudoRandom(state);
    const swapIndex = state % (index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
};
const createDeck = (round: number): Card[] => {
  const values = shuffleWithSeed([...ICONS, ...ICONS], MEMORY_SEED_BASE + (round * 97));
  return values.map((value, id) => ({ id, value, matched: false }));
};

export default function Home() {
  const [round, setRound] = useState(0);
  const [deck, setDeck] = useState<Card[]>(() => createDeck(0));
  const [openCards, setOpenCards] = useState<number[]>([]);
  const [moves, setMoves] = useState(0);
  const [locked, setLocked] = useState(false);
  const [message, setMessage] = useState('Trouvez toutes les paires de cartes de Noël.');
  const [reducedMotion, setReducedMotion] = useState(false);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReducedMotion(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    const timerRef = hideTimeout;
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const matchedPairs = useMemo(() => deck.filter(card => card.matched).length / 2, [deck]);
  const totalPairs = ICONS.length;
  const won = matchedPairs === totalPairs;

  useEffect(() => {
    if (won) setMessage('Bravo, toutes les paires sont trouvées !');
  }, [won]);

  const replay = () => {
    if (hideTimeout.current !== null) {
      clearTimeout(hideTimeout.current);
      hideTimeout.current = null;
    }
    const nextRound = round + 1;
    setRound(nextRound);
    setDeck(createDeck(nextRound));
    setOpenCards([]);
    setMoves(0);
    setLocked(false);
    setMessage('Nouvelle partie : trouvez toutes les paires.');
  };

  const reveal = (id: number) => {
    if (locked || won) return;
    if (openCards.includes(id) || deck[id]?.matched) return;
    const nextOpen = [...openCards, id];
    setOpenCards(nextOpen);
    if (nextOpen.length < 2) {
      setMessage('Choisissez une seconde carte.');
      return;
    }
    const [first, second] = nextOpen;
    setMoves(previous => previous + 1);
    setLocked(true);
    if (deck[first].value === deck[second].value) {
      setDeck(previous => previous.map(card => (card.id === first || card.id === second) ? { ...card, matched: true } : card));
      setOpenCards([]);
      setLocked(false);
      setMessage('Paire trouvée, continuez !');
      return;
    }
    setMessage('Ce n\'est pas une paire, réessayez.');
    const delay = reducedMotion ? 120 : 620;
    hideTimeout.current = setTimeout(() => {
      setOpenCards([]);
      setLocked(false);
      hideTimeout.current = null;
    }, delay);
  };

  return (
    <main className="memory-app">
      <header>
        <span className="eyebrow">NOËL 2026 · JEU GRATUIT</span>
        <h1>Noël Memory<span>.</span></h1>
        <p className="lead">Associez toutes les paires avec le moins de coups possible. Aucun compte, aucune pub, aucune donnée transmise.</p>
      </header>
      <section className="panel memory-panel" aria-labelledby="memory-title">
        <h2 id="memory-title">Plateau des paires</h2>
        <p className="memory-rules">Touchez ou activez une carte au clavier, puis trouvez sa jumelle.</p>
        <div className="memory-stats" aria-live="polite">
          <span><b>Coups</b> : {moves}</span>
          <span><b>Paires</b> : {matchedPairs}/{totalPairs}</span>
          <span><b>État</b> : {won ? 'Victoire' : 'En cours'}</span>
        </div>
        <p className="memory-status" role="status" aria-live="polite">{message}</p>
        <div className="memory-grid" role="group" aria-label="Cartes du Memory de Noël">
          {deck.map((card, index) => {
            const visible = card.matched || openCards.includes(card.id);
            return (
              <button
                key={card.id}
                type="button"
                className={'memory-card' + (visible ? ' visible' : '') + (card.matched ? ' matched' : '')}
                aria-label={'Carte ' + (index + 1) + (visible ? ', ' + card.value : ', cachée')}
                aria-pressed={visible}
                disabled={locked || card.matched || won}
                onClick={() => reveal(card.id)}
              >
                <span aria-hidden="true">{visible ? card.value : '❄️'}</span>
              </button>
            );
          })}
        </div>
        <div className="memory-actions">
          <button type="button" onClick={replay}>Rejouer</button>
        </div>
      </section>
      <section className="note">
        <h2>Accessibilité et limites</h2>
        <p>Le jeu fonctionne au clavier et au toucher, avec indication visuelle du focus et adaptation aux préférences de réduction des animations. Cette démo locale ne stocke rien à distance.</p>
      </section>
      <footer>Noël Memory · Prototype local autonome, sans paiement, cookie, tracking ni service externe.</footer>
    </main>
  );
}
`,
    smokeTest: String.raw`import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const page = readFileSync(path.join(process.cwd(), 'app/page.tsx'), 'utf8');
const ICONS = ['🎄', '🎁', '⛄', '🔔', '🧣', '🍪', '⭐', '🕯️'];
const MEMORY_SEED_BASE = 20261225;
const nextPseudoRandom = (state) => ((state * 1664525) + 1013904223) >>> 0;
const shuffleWithSeed = (items, seed) => {
  let state = seed >>> 0;
  const values = [...items];
  for (let index = values.length - 1; index > 0; index -= 1) {
    state = nextPseudoRandom(state);
    const swapIndex = state % (index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
};

test('noel-memory page advertises an accessible christmas memory game', () => {
  assert.match(page, /Noël Memory/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /role="group"/);
  assert.match(page, /Rejouer/);
  assert.doesNotMatch(page, /fetch\(|XMLHttpRequest|localStorage|sessionStorage|process\.env/);
});

test('deterministic deck shuffle remains stable for synthetic checks', () => {
  const cards = [...ICONS, ...ICONS];
  const first = shuffleWithSeed(cards, MEMORY_SEED_BASE);
  const second = shuffleWithSeed(cards, MEMORY_SEED_BASE);
  const replay = shuffleWithSeed(cards, MEMORY_SEED_BASE + 97);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, cards);
  assert.notDeepEqual(first, replay);
  assert.equal(first.length, cards.length);
});
`
  })
});

export const stylesheet = String.raw`:root{color-scheme:dark;font-family:Arial,Helvetica,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at top,#17384c 0,#0a1425 60%,#090e17 100%);color:#f3f8fc}main{max-width:800px;margin:0 auto;padding:60px 20px 48px}header{padding:20px 4px 40px}.eyebrow{color:#78efc3;letter-spacing:.14em;font-size:.75rem;font-weight:700}h1{font-size:clamp(3rem,9vw,5.2rem);letter-spacing:-.075em;margin:15px 0}h1 span{color:#78efc3}.lead{font-size:1.25rem;color:#cbd5e4;max-width:600px;line-height:1.5}.panel{background:rgba(23,43,60,.9);border:1px solid #426075;border-radius:22px;padding:clamp(20px,5vw,38px);box-shadow:0 28px 60px #0004}h2{margin:0 0 18px;font-size:1.4rem}.panel p,.note p{color:#cbd5e4;line-height:1.6}.fields{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:28px 0}label{display:block;font-size:.95rem;color:#f3f8fc;font-weight:600;margin-bottom:12px}input{width:100%;display:block;margin-top:8px;padding:15px 14px;border-radius:10px;border:1px solid #8fa7b6;background:#0e2031;color:#fff;font:inherit}input:focus-visible,button:focus-visible{outline:3px solid #78efc3;outline-offset:3px}.result{margin-top:25px;padding:24px;background:#d6fff0;color:#09372c;border-radius:16px;display:flex;flex-direction:column;gap:8px}.result strong{font-size:clamp(2.2rem,7vw,3.5rem);letter-spacing:-.05em}.result b{font-weight:700}.note{padding:35px 12px 8px}.error{color:#ffd8b5!important;font-weight:700}footer{border-top:1px solid #455d6d;color:#a6b9c7;margin-top:30px;padding-top:22px;font-size:.8rem}.gift{display:grid;grid-template-columns:1.5fr 1fr auto;gap:12px;align-items:end;margin-bottom:20px}.gift label{margin:0}button{border:0;border-radius:10px;background:#78efc3;color:#082f24;font-weight:700;font-size:1rem;padding:14px 18px;cursor:pointer}button:disabled{opacity:.6;cursor:not-allowed}.minor{background:transparent;color:#ddf1fa;border:1px solid #7994a3}.memory-panel{display:flex;flex-direction:column;gap:14px}.memory-rules{margin-top:-4px}.memory-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;font-size:.95rem}.memory-stats span{background:#0f2337;border:1px solid #385871;border-radius:10px;padding:10px 12px}.memory-status{background:#0d2930;border:1px solid #496f83;border-radius:10px;padding:10px 12px;color:#d9f7ff!important;font-weight:600}.memory-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.memory-card{aspect-ratio:1/1;display:grid;place-items:center;font-size:clamp(1.6rem,4.2vw,2.2rem);border:1px solid #6a8aa0;background:linear-gradient(160deg,#0d2a43,#122b38);color:#ecf8ff;border-radius:14px;transition:transform .15s ease,background .2s ease,border-color .2s ease}.memory-card.visible{background:#d6fff0;color:#09372c;border-color:#b5f2df;transform:translateY(-1px)}.memory-card.matched{background:#b8ffdf;color:#083526;border-color:#9cf0cb}.memory-actions{display:flex;justify-content:flex-start}.memory-actions button{min-width:140px}@media(max-width:650px){main{padding:30px 15px}.fields,.gift{grid-template-columns:1fr}.gift button{justify-self:start}.memory-stats{grid-template-columns:1fr}.memory-grid{gap:8px}}@media (prefers-reduced-motion: reduce){.memory-card{transition:none}}`;
