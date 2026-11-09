// Local, non-commercial demonstration templates. No network or payment provider.
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
});

export const stylesheet = String.raw`:root{color-scheme:dark;font-family:Arial,Helvetica,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at top,#17384c 0,#0a1425 60%,#090e17 100%);color:#f3f8fc}main{max-width:800px;margin:0 auto;padding:60px 20px 48px}header{padding:20px 4px 40px}.eyebrow{color:#78efc3;letter-spacing:.14em;font-size:.75rem;font-weight:700}h1{font-size:clamp(3rem,9vw,5.2rem);letter-spacing:-.075em;margin:15px 0}h1 span{color:#78efc3}.lead{font-size:1.25rem;color:#cbd5e4;max-width:600px;line-height:1.5}.panel{background:rgba(23,43,60,.9);border:1px solid #426075;border-radius:22px;padding:clamp(20px,5vw,38px);box-shadow:0 28px 60px #0004}h2{margin:0 0 18px;font-size:1.4rem}.panel p,.note p{color:#cbd5e4;line-height:1.6}.fields{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:28px 0}label{display:block;font-size:.95rem;color:#f3f8fc;font-weight:600;margin-bottom:12px}input{width:100%;display:block;margin-top:8px;padding:15px 14px;border-radius:10px;border:1px solid #8fa7b6;background:#0e2031;color:#fff;font:inherit}input:focus-visible,button:focus-visible{outline:3px solid #78efc3;outline-offset:3px}.result{margin-top:25px;padding:24px;background:#d6fff0;color:#09372c;border-radius:16px;display:flex;flex-direction:column;gap:8px}.result strong{font-size:clamp(2.2rem,7vw,3.5rem);letter-spacing:-.05em}.result b{font-weight:700}.note{padding:35px 12px 8px}.error{color:#ffd8b5!important;font-weight:700}footer{border-top:1px solid #455d6d;color:#a6b9c7;margin-top:30px;padding-top:22px;font-size:.8rem}.gift{display:grid;grid-template-columns:1.5fr 1fr auto;gap:12px;align-items:end;margin-bottom:20px}.gift label{margin:0}button{border:0;border-radius:10px;background:#78efc3;color:#082f24;font-weight:700;font-size:1rem;padding:14px 18px;cursor:pointer}button:disabled{opacity:.6;cursor:not-allowed}.minor{background:transparent;color:#ddf1fa;border:1px solid #7994a3}@media(max-width:650px){main{padding:30px 15px}.fields,.gift{grid-template-columns:1fr}.gift button{justify-self:start}}`;
