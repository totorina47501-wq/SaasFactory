// MVP Growth #65 : production deterministic drafts only; no network or publishing.
import {createGrowthPlan} from '../core/market.mjs';

const translations={
  'fr-FR':{
    problem:'Comprendre le problème',solution:'Explorer la solution',demo:'Demander une démonstration',
    checklist:'Checklist de préparation',guide:'Guide de découverte',research:'Vérifier les hypothèses avec des prospects volontaires',
    note:'Brouillon uniquement. Affirmer uniquement des résultats vérifiés.'
  },
  en:{
    problem:'Understand the problem',solution:'Explore the solution',demo:'Request a demo',
    checklist:'Launch checklist',guide:'Discovery guide',research:'Validate assumptions with willing prospects',
    note:'Draft only. Publish only evidence-backed claims.'
  }
};

function dateAt(startDate,offset){
  if(typeof startDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(startDate))
    throw new Error('startDate must be YYYY-MM-DD');
  const ms=Date.parse(startDate+'T00:00:00.000Z');
  if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==startDate)
    throw new Error('Invalid startDate');
  return new Date(ms+offset*86400000).toISOString().slice(0,10);
}
function markdownSafe(value){
  return String(value).replace(/[\r\n\t]+/g,' ').replace(/&/g,'&amp;')
    .replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\|/g,'\\|');
}
function createAcquisitionMvp(rawIntake,options={}){
  if(!options||typeof options!=='object'||Array.isArray(options)||
      Object.keys(options).some(key=>!['startDate','locale'].includes(key)))
    throw new Error('Unsupported acquisition options');
  const {startDate,locale='fr-FR'}=options;
  dateAt(startDate,0);
  const copy=translations[locale];
  if(!copy) throw new Error('Unsupported acquisition locale');
  const core=createGrowthPlan(rawIntake); // reuse strict Intake validation (#69)
  const topics=[copy.problem,copy.solution,copy.checklist,copy.guide,copy.demo,copy.research];
  const seoPages=['problem','solution','demo'].map(id=>({
    id,locale,path:'/'+locale+'/'+id,status:'draft',publishEnabled:false,claimsVerified:false,
    title:core.positioning.name+' — '+copy[id],
    description:core.positioning.summary,
    audience:core.audience,problem:core.problem,validationNote:copy.note
  }));
  const editorialCalendar=topics.map((topic,index)=>({
    id:'content-'+(index+1),date:dateAt(startDate,index*4),
    channel:index%2?'content':'seo',title:core.positioning.name+' — '+topic,
    status:'draft',evidence:'unverified',publishEnabled:false,spendCents:0
  }));
  const leadMagnets=[
    {id:'checklist',title:copy.checklist,steps:[core.problem,copy.research]},
    {id:'guide',title:copy.guide,steps:[core.positioning.summary,copy.research]}
  ].map(item=>({...item,status:'draft',collectionEnabled:false,
    formEnabled:false,deliveryEnabled:false,requiresApproval:true}));
  return {
    schemaVersion:1,kind:'saas-factory-acquisition-mvp',status:'draft-only',
    sourceKind:core.kind,projectSlug:core.projectSlug,locale,startDate,
    positioning:core.positioning,
    icp:{audience:core.audience,problem:core.problem,evidence:'unverified',
      interviewsRequired:true,legalBasisVerified:false},
    seoPages,editorialCalendar,leadMagnets,
    funnel:['seo','lead-magnet','activation','demo','conversion'].map((id,index)=>({
      id,order:index+1,status:'planned',measurementReady:false
    })),
    experiments:[{id:'landing-message-ab',status:'draft',executionEnabled:false,
      measurement:'consented-analytics',measurementReady:false,spendCents:0}],
    handoff:{apiVersion:1,target:'generated-saas',adapterRequired:true,
      automaticIntegration:false,analyticsReady:false,publishingReady:false},
    safeguards:{outreachEnabled:false,publishEnabled:false,
      formCollectionEnabled:false,externalProvidersActivated:false,spendAuthorized:false,
      budgetCents:0,claimsVerified:false,complianceCertified:false,commercialReadiness:false},
    note:copy.note
  };
}
function exportAcquisitionMvp(plan,format='json'){
  if(!plan||plan.kind!=='saas-factory-acquisition-mvp'||plan.status!=='draft-only')
    throw new Error('Only draft acquisition MVP exports are allowed');
  if(format==='json') return JSON.stringify(plan,null,2)+'\n';
  if(format!=='markdown') throw new Error('Unsupported export format');
  const md=markdownSafe;
  return [
    '# '+md(plan.positioning.name)+' — Growth MVP ('+md(plan.locale)+')',
    '', '> '+md(plan.note), '',
    '## ICP','- Audience : '+md(plan.icp.audience),
    '- Problème : '+md(plan.icp.problem),'- Validation terrain requise','',
    '## Pages SEO (brouillons)',
    ...plan.seoPages.map(p=>'- '+md(p.path)+' — '+md(p.title)),
    '', '## Calendrier éditorial',
    ...plan.editorialCalendar.map(p=>'- '+md(p.date)+' — '+md(p.title)+' (brouillon)'),
    '', '## Lead magnets (sans collecte)',
    ...plan.leadMagnets.map(p=>'- '+md(p.title)+' : '+p.steps.map(md).join(' ; ')),
    '', '## Funnel non activé',
    ...plan.funnel.map(s=>'- '+s.order+'. '+md(s.id)),
    '', 'Aucun envoi, publication, collecte, dépense ou intégration automatique.',''
  ].join('\n');
}
export {createAcquisitionMvp,exportAcquisitionMvp};
