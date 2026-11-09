// SaaSFactory SFV3-I18N: pure, offline FR/EN and safe public SEO contract.
const LOCALES=Object.freeze(['fr-FR','en']);
const DEFAULT_LOCALE='fr-FR';
const PRIVATE_PREFIXES=Object.freeze(['/dashboard','/settings','/account','/admin','/api','/auth','/login','/signup','/reset-password','/billing','/app','/private','/_next']);
const PUBLIC_ROUTES=Object.freeze(['/','/features','/pricing','/about']);
const DICTIONARIES=Object.freeze({
 'fr-FR':Object.freeze({
  'nav.home':'Accueil','nav.features':'Fonctionnalités','nav.pricing':'Tarifs','nav.about':'À propos',
  'common.draft':'Démonstration sans service activé',
  'marketing.title':'Une base pour votre prochain logiciel',
  'marketing.description':'Explorez des fonctionnalités modulaires sans engagement commercial.',
  'features.title':'Fonctionnalités modulaires',
  'features.description':'Découvrez les options que votre application pourrait proposer.',
  'pricing.title':'Offres à définir',
  'pricing.description':'Aucun prix, achat ou abonnement réel n’est proposé sur cette démonstration.',
  'about.title':'À propos du projet',
  'about.description':'Une présentation neutre du fonctionnement du produit.',
  'forms.label':'Votre recherche : {query}',
  'items.count.one':'{count} élément','items.count.other':'{count} éléments'
 }),
 en:Object.freeze({
  'nav.home':'Home','nav.features':'Features','nav.pricing':'Pricing','nav.about':'About',
  'common.draft':'Demonstration with no active services',
  'marketing.title':'A foundation for your next software product',
  'marketing.description':'Explore modular features without commercial commitments.',
  'features.title':'Modular features',
  'features.description':'Discover the options your application could offer.',
  'pricing.title':'Plans to be defined',
  'pricing.description':'No real prices, purchases or subscriptions are offered in this demonstration.',
  'about.title':'About this project',
  'about.description':'A neutral introduction to how the product works.',
  'forms.label':'Your search: {query}',
  'items.count.one':'{count} item','items.count.other':'{count} items'
 })
});
function assertLocale(locale){if(!LOCALES.includes(locale))throw Error('Unsupported locale');return locale;}
function localeFromInput(input,{fallback=DEFAULT_LOCALE}={}){
 assertLocale(fallback);
 if(typeof input!=='string'||input.length>200)return fallback;
 const tokens=input.split(',').slice(0,20).map(v=>{
  const [tag,...parts]=v.trim().split(';');
  const quality=parts.find(x=>x.trim().startsWith('q='));
  const q=quality?Number(quality.trim().slice(2)):1;
  return {tag:tag.trim().toLowerCase(),q:Number.isFinite(q)&&q>=0&&q<=1?q:0};
 }).sort((a,b)=>b.q-a.q);
 for(const {tag,q} of tokens){
  if(q===0)continue;
  if(tag==='fr-fr'||tag==='fr')return 'fr-FR';
  if(tag==='en'||tag.startsWith('en-'))return 'en';
 }
 return fallback;
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function t(key,{locale=DEFAULT_LOCALE,params={},fallback=DEFAULT_LOCALE}={}){
 assertLocale(locale);assertLocale(fallback);
 if(typeof key!=='string'||!Object.hasOwn(DICTIONARIES[fallback],key))throw Error('Unknown translation key');
 if(!params||typeof params!=='object'||Array.isArray(params))throw Error('Invalid translation parameters');
 const value=DICTIONARIES[locale][key]??DICTIONARIES[fallback][key];
 const expected=[...value.matchAll(/\{([a-z][a-z0-9]*)\}/gi)].map(m=>m[1]);
 if(Object.keys(params).some(k=>!expected.includes(k))||expected.some(k=>!Object.hasOwn(params,k)))throw Error('Translation parameter mismatch');
 return value.replace(/\{([a-z][a-z0-9]*)\}/gi,(_,k)=>{
  const v=params[k];
  if(!['string','number'].includes(typeof v)||!Number.isFinite(typeof v==='number'?v:0)||String(v).length>160)throw Error('Invalid translation parameter value');
  return escapeHtml(v);
 });
}
function countItems(count,{locale=DEFAULT_LOCALE}={}){
 assertLocale(locale);if(!Number.isSafeInteger(count)||count<0)throw Error('Invalid count');
 const category=new Intl.PluralRules(locale).select(count);
 return t('items.count.'+(category==='one'?'one':'other'),{locale,params:{count}});
}
function formatDate(date,{locale=DEFAULT_LOCALE,timeZone='UTC'}={}){
 assertLocale(locale);if(!(date instanceof Date)||!Number.isFinite(date.getTime()))throw Error('Invalid date');
 return new Intl.DateTimeFormat(locale,{timeZone,dateStyle:'medium'}).format(date);
}
function formatNumber(number,{locale=DEFAULT_LOCALE}={}){
 assertLocale(locale);if(typeof number!=='number'||!Number.isFinite(number))throw Error('Invalid number');
 return new Intl.NumberFormat(locale).format(number);
}
function createLocalePreference(storage,{key='saasfactory:locale',fallback=DEFAULT_LOCALE}={}){
 assertLocale(fallback);
 if(!storage||typeof storage.getItem!=='function'||typeof storage.setItem!=='function')throw Error('Storage adapter required');
 if(key!=='saasfactory:locale')throw Error('Unsupported preference key');
 return Object.freeze({
  read(){try{const locale=storage.getItem(key);return LOCALES.includes(locale)?locale:fallback;}catch{return fallback;}},
  write(locale){assertLocale(locale);try{storage.setItem(key,locale);return true;}catch{return false;}}
 });
}
function normalRoute(route){
 if(typeof route!=='string'||!route.startsWith('/')||route.startsWith('//')||route.includes('?')||route.includes('#')||route.includes('\\')||route.includes('%')||route.includes('..')||route.length>180)
  throw Error('Invalid route');
 return route.length>1?route.replace(/\/+$/,''):route;
}
function isPublicRoute(route){
 let path;try{path=normalRoute(route)}catch{return false;}
 if(PRIVATE_PREFIXES.some(prefix=>path===prefix||path.startsWith(prefix+'/')))return false;
 return PUBLIC_ROUTES.includes(path);
}
function safeSiteOrigin(origin){
 if(typeof origin!=='string')throw Error('Site origin required');
 let url;try{url=new URL(origin)}catch{throw Error('Invalid site origin')}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.hostname==='localhost'||url.hostname.endsWith('.localhost'))
  throw Error('HTTPS public site origin required');
 return url.origin;
}
function pathFor(route,locale){
 assertLocale(locale);route=normalRoute(route);
 if(!isPublicRoute(route))throw Error('Private or unlisted SEO route');
 return '/'+locale+(route==='/'?'':route);
}
const PAGE_KEYS=Object.freeze({
 '/':['marketing.title','marketing.description'],
 '/features':['features.title','features.description'],
 '/pricing':['pricing.title','pricing.description'],
 '/about':['about.title','about.description']
});
function publicMetadata({origin,locale=DEFAULT_LOCALE,route='/'}={}){
 origin=safeSiteOrigin(origin);assertLocale(locale);route=normalRoute(route);
 if(!isPublicRoute(route))throw Error('Private routes are not indexable');
 const keys=PAGE_KEYS[route],canonical=origin+pathFor(route,locale);
 const languages=Object.fromEntries(LOCALES.map(l=>[l,origin+pathFor(route,l)]));
 return Object.freeze({title:t(keys[0],{locale}),description:t(keys[1],{locale}),
  canonical,alternates:{languages},robots:{index:true,follow:true},
  openGraph:{type:'website',url:canonical,locale,title:t(keys[0],{locale})}});
}
function privateMetadata(){return {robots:{index:false,follow:false,nocache:true}};}
function createSitemap({origin}={}){
 origin=safeSiteOrigin(origin);
 return PUBLIC_ROUTES.flatMap(route=>LOCALES.map(locale=>({
  url:origin+pathFor(route,locale),
  alternates:{languages:Object.fromEntries(LOCALES.map(l=>[l,origin+pathFor(route,l)]))},
  changeFrequency:'monthly',priority:route==='/'?1:0.5
 })));
}
function createRobots({origin}={}){
 origin=safeSiteOrigin(origin);
 return {rules:[{userAgent:'*',allow:'/',disallow:[...PRIVATE_PREFIXES]}],sitemap:origin+'/sitemap.xml'};
}
function marketingPage({origin,locale=DEFAULT_LOCALE,route='/'}={}){
 const metadata=publicMetadata({origin,locale,route});
 return Object.freeze({schemaVersion:1,kind:'neutral-marketing-page',
  locale,route,metadata,status:'draft-only',publishEnabled:false,
  title:metadata.title,description:metadata.description,
  links:PUBLIC_ROUTES.map(p=>({href:pathFor(p,locale),label:t(p==='/'?'nav.home':'nav.'+p.slice(1),{locale})})),
  disclaimer:t('common.draft',{locale})});
}
function checkDictionaryParity(){
 const keys=Object.keys(DICTIONARIES[DEFAULT_LOCALE]).sort();
 if(!LOCALES.every(locale=>JSON.stringify(Object.keys(DICTIONARIES[locale]).sort())===JSON.stringify(keys)))
  throw Error('Locale dictionary key parity mismatch');
 for(const key of keys){
  const placeholders=locale=>[...DICTIONARIES[locale][key].matchAll(/\{([a-z][a-z0-9]*)\}/gi)].map(m=>m[1]).sort().join(',');
  if(!LOCALES.every(locale=>placeholders(locale)===placeholders(DEFAULT_LOCALE)))throw Error('Locale dictionary placeholder mismatch');
 }
 return true;
}
export {LOCALES,DEFAULT_LOCALE,DICTIONARIES,PRIVATE_PREFIXES,PUBLIC_ROUTES,
 localeFromInput,escapeHtml,t,countItems,formatDate,formatNumber,createLocalePreference,
 isPublicRoute,pathFor,publicMetadata,privateMetadata,createSitemap,createRobots,marketingPage,checkDictionaryParity};
