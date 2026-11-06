'use strict';
const REPO='totorina47501-wq/SaasFactory',BOT='copilot-pull-request-reviewer[bot]';
const MARKER='<!-- saasfactory:final-review-once:v1 -->';
function source(r,o,p,id) {
 return r?.name==='SaaS Factory CI' && r.event==='pull_request' &&
 r.conclusion==='success' && r.status==='completed' &&
 r.id===id && /^[a-f0-9]{40}$/i.test(r.head_sha||'') &&
 r.repository?.full_name===o+'/'+p && r.head_repository?.full_name===o+'/'+p &&
 Array.isArray(r.pull_requests) && r.pull_requests.length===1 &&
 Number.isSafeInteger(r.pull_requests[0]?.number) && r.pull_requests[0].number>0;
}
function eligible(p,o,r,sha) {
 return p?.state==='open' && p.draft===false && p.head?.sha===sha &&
 p.base?.ref==='main' && p.head?.repo?.full_name===o+'/'+r &&
 p.base?.repo?.full_name===o+'/'+r && p.head?.ref?.startsWith('copilot/') &&
 ['copilot','copilot-swe-agent[bot]'].includes(String(p.user?.login||'').toLowerCase());
}
async function run({github,context,core}) {
 const {owner,repo}=context.repo, ev=context.payload?.workflow_run;
 const result={decision:'skip',pr:null};
 if(owner+'/'+repo!==REPO || context.eventName!=='workflow_run' ||
 !source(ev,owner,repo,ev?.id)) return result;
 const wf=await github.rest.actions.getWorkflow({owner,repo,workflow_id:ev.workflow_id});
 if(wf.data?.path!=='.github/workflows/ci.yml' ||
 wf.data?.name!=='SaaS Factory CI' || wf.data?.state!=='active') return result;
 const n=ev.pull_requests[0].number;result.pr=n;
 const [p,real,identity]=await Promise.all([
 github.rest.pulls.get({owner,repo,pull_number:n}),
 github.rest.actions.getWorkflowRun({owner,repo,run_id:ev.id}),
 github.rest.users.getAuthenticated()]);
 if(!source(real.data,owner,repo,ev.id) || !eligible(p.data,owner,repo,ev.head_sha) ||
 !identity.data?.login || identity.data.login.endsWith('[bot]')) return result;
 const [reviews,pending,comments]=await Promise.all([
 github.paginate(github.rest.pulls.listReviews,{owner,repo,pull_number:n,per_page:100}),
 github.rest.pulls.listRequestedReviewers({owner,repo,pull_number:n}),
 github.paginate(github.rest.issues.listComments,{owner,repo,issue_number:n,per_page:100})]);
 if(!Array.isArray(reviews)||!Array.isArray(comments)||!Array.isArray(pending.data?.users))
 throw Error('Incomplete review evidence');
 if(reviews.some(v=>v.user?.login===BOT) ||
 pending.data.users.some(v=>v.login===BOT) ||
 comments.some(v=>v.user?.login===identity.data.login && v.body?.includes(MARKER))) {
 result.decision='already-requested';return result;
 }
 const latest=await github.rest.pulls.get({owner,repo,pull_number:n});
 if(!eligible(latest.data,owner,repo,ev.head_sha)) return result;
 // Reserve before the paid API request. An uncertain error NEVER retries.
 const reserved=await github.rest.issues.createComment({owner,repo,issue_number:n,
 body:MARKER+'\nOne Copilot review reserved for '+ev.head_sha+'. No automatic re-review on subsequent pushes.'});
 if(!Number.isSafeInteger(reserved.data?.id)) throw Error('Reservation not acknowledged');
 await github.rest.pulls.requestReviewers({owner,repo,pull_number:n,reviewers:[BOT]});
 core?.notice?.('Final review requested for PR #'+n);
 result.decision='requested';return result;
}
module.exports={run,source,eligible,MARKER};
