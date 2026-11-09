import test from 'node:test';
import assert from 'node:assert/strict';
import {
 LOCALES,DICTIONARIES,localeFromInput,t,countItems,formatDate,formatNumber,
 createLocalePreference,isPublicRoute,pathFor,publicMetadata,privateMetadata,
 createSitemap,createRobots,marketingPage,checkDictionaryParity
} from '../modules/i18n-seo/index.mjs';

test('FR/EN key parity, placeholders and explicit safe translation fallback',()=>{
 assert.equal(checkDictionaryParity(),true);
 assert.equal(Object.keys(DICTIONARIES.en).length,Object.keys(DICTIONARIES['fr-FR']).length);
 assert.equal(t('nav.home',{locale:'en'}),'Home');
 assert.equal(t('nav.home',{locale:'fr-FR'}),'Accueil');
 assert.equal(t('forms.label',{locale:'en',params:{query:'<script>alert(1)</script>'}}),
  'Your search: &lt;script&gt;alert(1)&lt;/script&gt;');
 assert.throws(()=>t('not-a-key'),/Unknown/);
 assert.throws(()=>t('forms.label',{params:{query:'abc',secret:'123'}}),/mismatch/);
 assert.throws(()=>t('forms.label',{params:{}}),/mismatch/);
 assert.throws(()=>t('nav.home',{locale:'es'}),/locale/);
});

test('accept-language negotiation, plural, dates and numbers',()=>{
 assert.equal(localeFromInput('es;q=0.9,fr-FR;q=0.8,en;q=0.7'),'fr-FR');
 assert.equal(localeFromInput('en-US,en;q=0.8'),'en');
 assert.equal(localeFromInput('de'),'fr-FR');
 assert.equal(localeFromInput('en;q=0,fr;q=0.4'),'fr-FR');
 assert.equal(countItems(1,{locale:'en'}),'1 item');
 assert.equal(countItems(2,{locale:'en'}),'2 items');
 assert.equal(countItems(0,{locale:'fr-FR'}),'0 élément');
 assert.throws(()=>countItems(-1),/count/);
 assert.match(formatDate(new Date('2026-11-09T00:00:00Z'),{locale:'en'}),/Nov/);
 assert.equal(typeof formatNumber(12345.6,{locale:'fr-FR'}),'string');
 assert.throws(()=>formatNumber(NaN),/number/);
});

test('locale preference uses injected noncookie storage with fallback',()=>{
 const map=new Map();
 const storage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)};
 const pref=createLocalePreference(storage);
 assert.equal(pref.read(),'fr-FR');
 assert.equal(pref.write('en'),true);
 assert.equal(pref.read(),'en');
 assert.throws(()=>pref.write('es'),/locale/);
 const readonly=createLocalePreference({
  getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}
 });
 assert.equal(readonly.read(),'fr-FR');
 assert.equal(readonly.write('en'),false);
});

test('SEO whitelist rejects private and unsafe paths, canonical requires HTTPS',()=>{
 const origin='https://saas.example';
 const all=LOCALES.flatMap(locale=>['/','/features','/pricing','/about']
  .map(route=>publicMetadata({origin,locale,route})));
 assert.equal(new Set(all.map(m=>m.canonical)).size,8);
 assert.ok(all.every(m=>m.robots.index===true&&m.canonical.startsWith(origin+'/')));
 assert.deepEqual(privateMetadata(),{robots:{index:false,follow:false,nocache:true}});
 for(const route of ['/dashboard','/settings','/api','/admin','/auth','/login',
  '/reset-password/complete','/_next/static','/pricing/private','//external',
  '/%2fapi','/../about']){
  assert.equal(isPublicRoute(route),false,route);
  assert.throws(()=>publicMetadata({origin,route}),/route|Private|Invalid/);
 }
 assert.throws(()=>publicMetadata({origin:'http://saas.example'}),/HTTPS/);
 assert.throws(()=>publicMetadata({origin:'https://user:pass@saas.example'}),/HTTPS/);
 assert.equal(pathFor('/features','en'),'/en/features');
});

test('sitemap, robots and draft marketing pages never leak tenant routes',()=>{
 const origin='https://saas.example';
 const sitemap=createSitemap({origin});
 assert.equal(sitemap.length,8);
 assert.equal(new Set(sitemap.map(x=>x.url)).size,8);
 assert.ok(sitemap.every(x=>x.url.startsWith(origin+'/')));
 assert.ok(sitemap.every(x=>!x.url.includes('/dashboard')&&!x.url.includes('/admin')));
 const robots=createRobots({origin});
 assert.ok(robots.rules[0].disallow.includes('/settings'));
 assert.equal(robots.sitemap,origin+'/sitemap.xml');
 const page=marketingPage({origin,locale:'en',route:'/pricing'});
 assert.equal(page.status,'draft-only');
 assert.equal(page.publishEnabled,false);
 assert.match(page.description,/No real prices/);
 assert.equal(page.links.length,4);
 assert.throws(()=>marketingPage({origin,route:'/login'}),/Private/);
});
