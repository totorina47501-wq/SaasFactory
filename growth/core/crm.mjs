// Local-only CRM kernel. It has no send/connect/provider functions.
const stages=['new','qualified','contacted','proposal','won','lost'];
function safeId(value,label) {
 if(typeof value!=='string'||!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(value)||value.length>64)
 throw Error('Invalid '+label);
 return value;
}
function text(value,label,max=160) {
 if(typeof value!=='string'||!value.trim()||value.length>max||
 /[\x00-\x1f\x7f]/.test(value))throw Error('Invalid '+label);
 return value.trim();
}
function requireKeys(obj,allowed,required) {
 if(!obj||typeof obj!=='object'||Array.isArray(obj)||
 Object.keys(obj).some(k=>!allowed.includes(k))||
 required.some(k=>!Object.hasOwn(obj,k)))throw Error('Invalid CRM input shape');
}
function createLocalCrm({tenantId}) {
 safeId(tenantId,'tenant id');
 const leads=new Map(),drafts=new Map(),journal=[];
 function addLead(lead){
  requireKeys(lead,['id','segment','legalBasis','basisEvidence'],['id','segment','legalBasis']);
  const id=safeId(lead.id,'lead id');
  if(leads.has(id))throw Error('Duplicate lead');
  const basis=lead.legalBasis;
  if(!['none','consent','legitimate-interest-b2b'].includes(basis))throw Error('Unsupported legal basis');
  if(basis!=='none')text(lead.basisEvidence,'basisEvidence',240);
  if(basis==='none' && Object.hasOwn(lead,'basisEvidence'))throw Error('No legal basis evidence expected');
  const record={tenantId,id,segment:text(lead.segment,'segment'),
   legalBasis:basis,basisEvidence:basis==='none'?null:lead.basisEvidence.trim(),
   stage:'new',suppressed:false};
  leads.set(id,record);
  journal.push({kind:'lead-created',id});
  return {...record};
 }
 function updateStage(id,stage){
  safeId(id,'lead id');
  if(!stages.includes(stage))throw Error('Unsupported pipeline stage');
  const item=leads.get(id);
  if(!item)throw Error('Lead not found');
  if(['won','lost'].includes(item.stage) && stage!==item.stage)
   throw Error('Terminal stage cannot be changed');
  item.stage=stage;journal.push({kind:'stage-changed',id,stage});
  return {...item};
 }
 function optOut(id){
  safeId(id,'lead id');const item=leads.get(id);
  if(!item)throw Error('Lead not found');
  if(!item.suppressed){item.suppressed=true;journal.push({kind:'opt-out',id});}
  return {...item};
 }
 function addDraft(draft){
  requireKeys(draft,['id','channel','message','targetSegment'],['id','channel','message','targetSegment']);
  const id=safeId(draft.id,'draft id');
  if(drafts.has(id))throw Error('Duplicate campaign');
  if(!['seo','content','email','social','sales-outreach'].includes(draft.channel))
   throw Error('Unsupported channel');
  const d={tenantId,id,channel:draft.channel,targetSegment:text(draft.targetSegment,'targetSegment'),
   message:text(draft.message,'message',1000),status:'draft',deliveryEnabled:false,
   spendingEnabled:false,approvalRequired:true};
  drafts.set(id,d);journal.push({kind:'campaign-draft',id});
  return {...d};
 }
 function snapshot(){
  const stageCounts=Object.fromEntries(stages.map(s=>[s,0]));
  let suppressed=0;
  for(const item of leads.values()){stageCounts[item.stage]++;if(item.suppressed)suppressed++;}
  return {schemaVersion:1,mode:'local-demo',tenantId,
    stageCounts,suppressed,leadCount:leads.size,campaignDrafts:drafts.size,
    outboundEnabled:false,providerConnected:false,auditEvents:journal.length};
 }
 function clear(){ leads.clear();drafts.clear();journal.length=0; }
 return {addLead,updateStage,optOut,addDraft,snapshot,clear};
}
export {createLocalCrm};
