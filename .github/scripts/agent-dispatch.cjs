'use strict';
// Fail closed: ONLY approved issues, no product deployments, no automated merges.
module.exports = async ({github, context, core, fs}) => {
  const owner = context.repo.owner, repo = context.repo.repo;
  if (`${owner}/${repo}` !== process.env.EXPECTED_REPO) throw Error('Repository guard rejected');
  const report = {at:new Date().toISOString(), repo:`${owner}/${repo}`, sha:context.sha, run:context.runId, decision:'none', active:[], eligible:[], blockers:[], prs:[]};
  const save = () => {
    fs.writeFileSync('agent-dispatch-report.json', JSON.stringify(report,null,2)+'\n');
    core.summary.addHeading('SaaS Factory agent dispatch').addRaw('\n```json\n'+JSON.stringify(report,null,2)+'\n```\n');
  };
  try {
    const [issues, prs] = await Promise.all([
      github.paginate(github.rest.issues.listForRepo,{owner,repo,state:'open',per_page:100}),
      github.paginate(github.rest.pulls.list,{owner,repo,state:'open',per_page:100})
    ]);
    const work = issues.filter(i=>!i.pull_request);
    const has = (i,label)=>i.labels.some(l=>(typeof l==='string'?l:l.name)===label);
    const matches = (pr,i)=>new RegExp('(?:fixes|closes|resolves)\\s+#'+i.number+'\\b','i').test(pr.body||'') || (pr.body||'').includes('#'+i.number);
    // A Copilot-assigned issue holds capacity even before the corresponding PR opens.
    const assigned = work.filter(i=>i.assignees.some(a=>/^(copilot|copilot-swe-agent)(\[bot\])?$/i.test(a.login)) ||
      has(i,'agent:in-progress') || has(i,'agent:review') || has(i,'agent:blocked'));
    const active = new Set(assigned.map(i=>i.number));
    for(const p of prs) {
      report.prs.push({number:p.number,head:p.head.ref,draft:p.draft,author:p.user?.login});
      if(p.user?.login==='Copilot' || p.head.ref.startsWith('copilot/')) {
        const linked=work.find(i=>matches(p,i));
        if(linked) active.add(linked.number);
        else report.blockers.push(`Unlinked Copilot PR #${p.number}: manual review needed`);
      }
    }
    report.active=[...active].sort((a,b)=>a-b);
    // Unknown PR ownership: do not start potentially overlapping work.
    if(report.blockers.length) {report.decision='blocked:unlinked-pr';return;}
    if(active.size>=2){report.decision='capacity-full';return;}
    const candidates=work.filter(i=>has(i,'agent:approved')&&!has(i,'agent:blocked')&&!has(i,'agent:in-progress')&&!has(i,'agent:review')&&!active.has(i.number)&&i.assignees.length===0);
    const weight=i=>has(i,'priority:p0')?0:has(i,'priority:p1')?1:has(i,'priority:p2')?2:3;
    candidates.sort((a,b)=>weight(a)-weight(b)||a.number-b.number);
    report.eligible=candidates.map(i=>i.number);
    if(!candidates.length){report.decision='idle:no-approved-missions';return;}
    const issue=candidates[0];
    // Protect against file ownership conflicts: declared paths are mandatory while PRs are open.
    const scope=(issue.body||'').match(/^Files:\s*(.+)$/im)?.[1]?.split(',').map(s=>s.trim()).filter(Boolean);
    if(!scope?.length){report.decision='blocked:missing-files-scope';report.blockers.push(`Issue #${issue.number} requires a 'Files: path1, path2' declaration`);return;}
    for(const occupied of assigned){
      if(occupied.number===issue.number) continue;
      const owned=(occupied.body||'').match(/^Files:\s*(.+)$/im)?.[1]?.split(',').map(s=>s.trim()).filter(Boolean);
      if(!owned?.length){report.decision='blocked:unknown-active-scope';report.blockers.push(`Active issue #${occupied.number} has no declared Files scope`);return;}
      if(owned.some(s=>scope.some(t=>s===t || (s.endsWith('/')&&t.startsWith(s)) || (t.endsWith('/')&&s.startsWith(t))))){
        report.decision='blocked:active-file-overlap';report.blockers.push(`Issue #${issue.number} overlaps active issue #${occupied.number}`);return;
      }
    }
    for(const p of prs){
      const files=await github.paginate(github.rest.pulls.listFiles,{owner,repo,pull_number:p.number,per_page:100});
      if(files.some(f=>scope.some(s=>f.filename===s || (s.endsWith('/')&&f.filename.startsWith(s))))){
        report.decision='blocked:file-overlap';report.blockers.push(`Issue #${issue.number} conflicts with PR #${p.number}`);return;
      }
    }
    // REST assignment support is in preview and GITHUB_TOKEN might lack authorization.
    // Do not mark success until GitHub confirms both assignee and read-back.
    await github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/assignees',{
      owner,repo,issue_number:issue.number,assignees:['copilot-swe-agent[bot]'],
      agent_assignment:{target_repo:`${owner}/${repo}`,base_branch:'main'}
    });
    const result=await github.rest.issues.get({owner,repo,issue_number:issue.number});
    if(!result.data.assignees.some(a=>/^(Copilot|copilot-swe-agent)(\[bot\])?$/i.test(a.login))) throw Error('Copilot assignment not confirmed by read-back');
    await github.rest.issues.addLabels({owner,repo,issue_number:issue.number,labels:['agent:in-progress']});
    report.decision=`assigned:#${issue.number}`;
  } catch(e) {
    report.decision='error';report.blockers.push(e.message);
    throw e;
  } finally {
    save();
    if(new Date().getUTCHours()%6===0 && new Date().getUTCMinutes()<30) core.notice('Six-hour summary: see artifact and job summary; scheduled UTC window.');
    await core.summary.write();
  }
};
