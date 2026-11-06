'use strict';
// Reconcile existing Project V2 cards only. Never create items or assign agents.
const REPO='totorina47501-wq/SaasFactory', OWNER='totorina47501-wq', TITLE='SaaSFactory — Agents';
const STATES=['Backlog','Approved','Assigned','Coding','In Progress','PR Review','CI Blocked','Done'];
function desiredStatus(c){
  if(!c || c.repository?.nameWithOwner!==REPO) return null;
  const labs=new Set((c.labels?.nodes||[]).map(x=>x.name));
  if(c.__typename==='Issue'){
    if(c.state==='CLOSED') return c.stateReason==='COMPLETED'?'Done':'Backlog';
    if(c.state!=='OPEN') return null;
    if(labs.has('agent:blocked')) return 'CI Blocked';
    if(labs.has('agent:review')) return 'PR Review';
    if(labs.has('agent:coding')) return 'Coding';
    if(labs.has('agent:in-progress')) return 'In Progress';
    if((c.assignees?.nodes||[]).some(x=>/^(copilot|copilot-swe-agent)(\[bot\])?$/i.test(x.login))) return 'Assigned';
    return labs.has('agent:approved')?'Approved':labs.has('agent:planned')?'Backlog':null;
  }
  if(c.__typename==='PullRequest'){
    if(c.merged) return 'Done';
    if(c.prState!=='OPEN') return null;
    return labs.has('agent:blocked')?'CI Blocked':'PR Review';
  }
  return null;
}
function parseDependencies(c){
  if(c?.__typename!=='Issue') return {declared:false,valid:false,items:[]};
  const lines=[...(c.body||'').matchAll(/^Depends-On:\s*(.*?)\s*$/gim)];
  if(lines.length!==1) return {declared:false,valid:false,items:[]};
  const line=lines[0][1].trim();
  if(/^(none|aucun|aucune)$/i.test(line)) return {declared:true,valid:true,items:[]};
  const items=[];
  for(const token of line.split(/[,;]/).map(x=>x.trim()).filter(Boolean)){
    const m=token.match(/^(?:(issue|pr|pull_request)\s*)?#?(\d+)$/i);
    if(!m) return {declared:true,valid:false,items:[]};
    const kind=m[1]?.toLowerCase();
    const number=Number(m[2]);
    if(!Number.isSafeInteger(number)||number<1) return {declared:true,valid:false,items:[]};
    const dependency={kind:kind==='pr'||kind==='pull_request'?'pull_request':'issue',number,explicit:!!kind};
    if(items.some(x=>x.kind===dependency.kind&&x.number===dependency.number)) return {declared:true,valid:false,items:[]};
    items.push(dependency);
  }
  return {declared:true,valid:items.length>0,items};
}
function lifecycleStatus(c,dependencyStatus){
  if(!c || c.repository?.nameWithOwner!==REPO) return 'unmapped';
  if(c.__typename==='Issue'){
    if(c.state==='CLOSED') return c.stateReason==='COMPLETED'?'done':c.stateReason==='NOT_PLANNED'?'not_planned':'closed_unverified';
    if(c.state!=='OPEN') return 'unmapped';
    const labs=new Set((c.labels?.nodes||[]).map(x=>x.name));
    if(labs.has('agent:blocked')) return 'CI blocked';
    if(labs.has('agent:review')) return 'review';
    if(labs.has('agent:coding')) return 'coding';
    if(labs.has('agent:in-progress')) return 'in progress';
    if((c.assignees?.nodes||[]).some(x=>/^(copilot|copilot-swe-agent)(\[bot\])?$/i.test(x.login))) return 'assigned';
    if(labs.has('agent:approved')) return 'approved';
    if(labs.has('agent:planned')) return dependencyStatus?.ready?'planned':'waiting';
  } else if(c.__typename==='PullRequest'){
    if(c.merged) return 'done';
    if(c.prState==='CLOSED') return 'closed_unmerged';
    if(c.prState==='OPEN') return c.labels?.nodes?.some(x=>x.name==='agent:blocked')?'CI blocked':'review';
  }
  return 'unmapped';
}
const QUERY=[
  'query($login:String!,$number:Int!,$cursor:String){',
  'user(login:$login){projectV2(number:$number){id title url',
  'fields(first:50){pageInfo{hasNextPage} nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}',
  'items(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id',
  'fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name optionId}}',
  'content{__typename',
  '... on Issue{number state stateReason body repository{nameWithOwner} labels(first:100){pageInfo{hasNextPage} nodes{name}} assignees(first:20){pageInfo{hasNextPage} nodes{login}}}',
  '... on PullRequest{number prState:state merged repository{nameWithOwner} labels(first:100){pageInfo{hasNextPage} nodes{name}} closingIssuesReferences(first:100){pageInfo{hasNextPage} nodes{number repository{nameWithOwner}}}}',
  '}}}}}}'
].join(' ');
const MUTATION=[
  'mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){',
  'updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,',
  'value:{singleSelectOptionId:$option}}){projectV2Item{id}}}'
].join(' ');
async function sync({graphql,core,apply=false}){
  if(process.env.GITHUB_REPOSITORY!==REPO) throw Error('Repository guard rejected');
  let cursor=null,project=null,rows=[],cursors=new Set();
  for(;;){
    const response=await graphql(QUERY,{login:OWNER,number:2,cursor});
    const x=response?.user?.projectV2;
    if(!x||x.title!==TITLE||(project&&project.id!==x.id)) throw Error('Unexpected project identity');
    if(!Array.isArray(x.fields?.nodes)||typeof x.fields?.pageInfo?.hasNextPage!=='boolean'||
      x.fields.pageInfo.hasNextPage||!Array.isArray(x.items?.nodes)||
      typeof x.items?.pageInfo?.hasNextPage!=='boolean') throw Error('Incomplete project items response');
    for(const row of x.items.nodes){
      if(!row||typeof row.id!=='string'||!Object.hasOwn(row,'fieldValueByName')||
        (row.fieldValueByName!==null&&(typeof row.fieldValueByName?.name!=='string'||
          typeof row.fieldValueByName?.optionId!=='string'))||
        (row.content&&!row.content.__typename)) throw Error('Incomplete project item response');
      if(row.content?.__typename==='Issue'){
        const c=row.content;
        if(!Number.isSafeInteger(c.number)||typeof c.repository?.nameWithOwner!=='string'||
          !['OPEN','CLOSED'].includes(c.state)||
          !Object.hasOwn(c,'stateReason')||!(c.body===null||typeof c.body==='string')||
          !Array.isArray(c.labels?.nodes)||typeof c.labels?.pageInfo?.hasNextPage!=='boolean'||
          c.labels.pageInfo.hasNextPage||c.labels.nodes.some(label=>typeof label?.name!=='string')||
          !Array.isArray(c.assignees?.nodes)||typeof c.assignees?.pageInfo?.hasNextPage!=='boolean'||
          c.assignees.pageInfo.hasNextPage||c.assignees.nodes.some(user=>typeof user?.login!=='string')) {
          throw Error('Incomplete issue status response');
        }
      }
      if(row.content?.__typename==='PullRequest'){
        const c=row.content;
        if(!Number.isSafeInteger(c.number)||typeof c.repository?.nameWithOwner!=='string'||
          !['OPEN','CLOSED'].includes(c.prState)||typeof c.merged!=='boolean'||
          !Array.isArray(c.labels?.nodes)||typeof c.labels?.pageInfo?.hasNextPage!=='boolean'||
          c.labels.pageInfo.hasNextPage||c.labels.nodes.some(label=>typeof label?.name!=='string')||
          !Array.isArray(c.closingIssuesReferences?.nodes)||
          typeof c.closingIssuesReferences?.pageInfo?.hasNextPage!=='boolean'||
          c.closingIssuesReferences.pageInfo.hasNextPage||
          c.closingIssuesReferences.nodes.some(ref=>!Number.isSafeInteger(ref?.number)||
            typeof ref.repository?.nameWithOwner!=='string')) throw Error('Incomplete pull request dependency response');
      }
    }
    project=x;rows.push(...x.items.nodes);
    if(rows.length>500) throw Error('Too many project items');
    if(!x.items?.pageInfo?.hasNextPage) break;
    cursor=x.items.pageInfo.endCursor;
    if(!cursor||cursors.has(cursor)) throw Error('Repeated pagination cursor');
    cursors.add(cursor);
  }
  const field=project.fields.nodes.find(x=>x?.name==='Status'&&x.options);
  if(!field) throw Error('Missing Status field');
  if(field.options.some(option=>typeof option?.name!=='string'||typeof option?.id!=='string')||
    new Set(field.options.map(option=>option.name)).size!==field.options.length) {
    throw Error('Incomplete Status options');
  }
  const options=new Map(field.options.map(o=>[o.name,o.id]));
  for(const x of STATES) if(!options.has(x)) throw Error('Missing Status option: '+x);
  const seen=new Set(),dupes=new Set();
  for(const row of rows){
    const c=row.content;
    if(!c||c.repository?.nameWithOwner!==REPO) continue;
    const key=c.__typename+':'+c.number;
    if(seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  const changes=[];
  const issues=new Map(),pullRequests=new Map(),deliveredIssues=new Set();
  for(const row of rows){
    const c=row.content;
    if(c?.repository?.nameWithOwner!==REPO) continue;
    if(c.__typename==='Issue') issues.set(c.number,c);
    if(c.__typename==='PullRequest'){
      pullRequests.set(c.number,c);
      if(c.merged) for(const ref of c.closingIssuesReferences.nodes){
        if(ref.repository?.nameWithOwner===REPO) deliveredIssues.add(ref.number);
      }
    }
  }
  const cards=[];
  for(const row of rows){
    const c=row.content;
    if(!c||c.repository?.nameWithOwner!==REPO) continue;
    const key=c.__typename+':'+c.number,to=desiredStatus(c);
    if(dupes.has(key)||!to||row.fieldValueByName?.name===to) continue;
    changes.push({key,itemId:row.id,from:row.fieldValueByName?.name||'(unset)',to});
  }
  for(const row of rows){
    const c=row.content;
    if(!c||c.repository?.nameWithOwner!==REPO) continue;
    const parsed=parseDependencies(c);
    const dependencies=parsed.items.map(dependency=>{
      let kind=dependency.kind;
      if(!dependency.explicit&&issues.has(dependency.number)&&pullRequests.has(dependency.number)){
        return {...dependency,status:'ambiguous'};
      }
      if(!dependency.explicit&&!issues.has(dependency.number)&&pullRequests.has(dependency.number)) kind='pull_request';
      if(dupes.has(`${kind==='pull_request'?'PullRequest':'Issue'}:${dependency.number}`)){
        return {...dependency,status:'ambiguous'};
      }
      const target=kind==='issue'?issues.get(dependency.number):pullRequests.get(dependency.number);
      let status='missing';
      if(target&&kind==='issue'){
        status=target.state==='CLOSED'&&target.stateReason==='NOT_PLANNED'?'not_planned':
          target.state==='CLOSED'&&target.stateReason==='COMPLETED'?
            (deliveredIssues.has(dependency.number)?'done':'unverified'):'open';
      } else if(target) status=target.merged?'done':target.prState==='CLOSED'?'closed_unmerged':'open';
      return {kind,number:dependency.number,status};
    });
    const ready=parsed.declared&&parsed.valid&&dependencies.every(x=>x.status==='done');
    cards.push({
      key:c.__typename+':'+c.number,projectStatus:row.fieldValueByName?.name||'(unset)',
      status:lifecycleStatus(c,{ready}),
      dependencyStatus:parsed.declared?(parsed.valid?(ready?'ready':'waiting'):'invalid'):'unknown',
      dependencies:parsed.declared&&parsed.valid?dependencies:[]
    });
  }
  if(dupes.size&&apply) throw Error('Duplicate project cards; refusing to write');
  if(changes.length>100) throw Error('Too many status updates; refusing to write');
  // GraphQL mutations are not atomic across cards: preserve audit evidence on partial failures.
  const report={mode:apply?'apply':'dry-run',project:project.url,items:rows.length,
    duplicates:[...dupes],cards,changes:changes.map(({key,from,to})=>({key,from,to})),
    applied:[],failed:null};
  try {
    if(apply) for(const c of changes){
      try {
        const result=await graphql(MUTATION,{project:project.id,item:c.itemId,field:field.id,option:options.get(c.to)});
        if(result?.updateProjectV2ItemFieldValue?.projectV2Item?.id!==c.itemId) throw Error('Incomplete mutation acknowledgement');
        report.applied.push({key:c.key,from:c.from,to:c.to});
      } catch(err) {
        report.failed={key:c.key,from:c.from,to:c.to};
        throw err;
      }
    }
  } finally {
    core.info(JSON.stringify(report));
    await core.summary.addHeading('SaaSFactory Projects V2 status sync')
      .addRaw('\nMode: **'+report.mode+'**; cards: '+rows.length+'; planned: '+changes.length+
        '; applied: '+report.applied.length+'; duplicates: '+dupes.size+'; failed: '+
        (report.failed?.key||'none')+'\n')
      .addCodeBlock(JSON.stringify({cards:report.cards,planned:report.changes,applied:report.applied,failed:report.failed},null,2),'json').write();
  }
  return report;
}
module.exports={sync,desiredStatus};
