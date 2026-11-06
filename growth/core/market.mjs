// GTM draft planner v1. Uses the existing strict Intake parser and validator.
import {parseConfigText} from '../../generate.mjs';
import {verifyIntake} from '../../intake.mjs';

const channels=['seo','content','sales-outreach'];
const outputKinds=['market-hypothesis','landing-draft','campaign-draft'];
function createGrowthPlan(rawText) {
  if(typeof rawText!=='string') throw new TypeError('Intake JSON text required');
  const intake=verifyIntake(parseConfigText(rawText));
  const {product,market,mvp,generatorConfig}=intake;
  const recommendedMvp=mvp.filter(x=>x.priority==='p0').map(x=>x.id);
  const plan={
    schemaVersion:1,kind:'saas-factory-gtm-plan',
    status:'draft-only',marketEvidence:'unverified',
    projectSlug:generatorConfig.projectSlug,
    audience:market.audience,
    problem:market.problem,
    monetizationHypothesis:market.monetization,
    positioning:{name:product.name,summary:product.summary,claimStatus:'unverified',validationRequired:true},
    mvpFocus:recommendedMvp,
    researchQuestions:[
      'Who experiences the stated problem and how frequently?',
      'What alternatives do prospective buyers currently use?',
      'What price and buying process can be supported by customer evidence?',
    ],
    campaigns:channels.map((channel,index)=>({
      id:'gtm-'+String(index+1),channel,
      status:'draft',sendEnabled:false,spendEnabled:false,budgetCents:0,
      audience:market.audience,requiresApproval:true,
      deliverable:outputKinds[index],
    })),
    metrics:[
      {id:'qualified-visits',source:'consented-analytics',ready:false},
      {id:'activated-users',source:'consented-analytics',ready:false},
      {id:'trial-to-paid',source:'billing-simulation',ready:false},
    ],
    safeguards:{
      competitorClaimsVerified:false,marketFitVerified:false,
      externalProvidersActivated:false,commercialMessagesSent:false,
      spendingAuthorized:false,salesDataImported:false,
      readyForProduction:false,
    },
  };
  return plan;
}
function recommendNextActions({report,minSample=30}={}) {
  if(!report||report.kind!=='saas-factory-growth-metrics'||report.mode!=='simulation')
    throw new Error('Only synthetic growth metrics may drive draft recommendations');
  if(!Number.isSafeInteger(minSample)||minSample<10||minSample>10000)
    throw new Error('Invalid minimum sample');
  const candidates=[];
  if(report.counts.visits < minSample)
    candidates.push({id:'collect-evidence',kind:'research',priority:'p1',
      rationale:'Insufficient consented visit sample',automaticExecution:false});
  else if(report.counts.signups * 10 < report.counts.visits)
    candidates.push({id:'validate-onboarding',kind:'product',priority:'p1',
      rationale:'Low simulated visit-to-signup ratio; investigate before changing product',
      automaticExecution:false});
  else candidates.push({id:'qualitative-review',kind:'research',priority:'p2',
      rationale:'Review segments and product hypotheses; no statistical claim made',
      automaticExecution:false});
  return {kind:'saas-factory-growth-recommendations',mode:'draft-only',
    actions:candidates,issuesCreated:false,campaignsSent:false};
}
export {createGrowthPlan,recommendNextActions};
