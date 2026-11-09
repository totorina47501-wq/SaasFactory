// Growth #65: draft-only bridge to the reusable neutral FR/EN SEO contract (#44).
// This is not a publishing, analytics, lead collection, or generator integration.
import {createAcquisitionMvp} from './mvp.mjs';
import {publicMetadata,createSitemap,createRobots} from '../../modules/i18n-seo/index.mjs';

const ROUTE_FOR_ID=Object.freeze({problem:'/',solution:'/features',demo:'/about'});
function createGrowthSeoPreview(rawIntake,{startDate,locale='fr-FR',origin}={}){
 const growth=createAcquisitionMvp(rawIntake,{startDate,locale});
 const previewPages=growth.seoPages.map(page=>{
  const publicRoute=ROUTE_FOR_ID[page.id];
  if(!publicRoute)throw Error('Unsupported growth page role');
  const metadata=publicMetadata({origin,locale,route:publicRoute});
  return {
   id:page.id,sourceDraftTitle:page.title,sourcePath:page.path,
   publicRoute,metadata,status:'draft',publicationAllowed:false,
   claimsVerified:false,requiresReview:true,
   // Marketing metadata is deliberately neutral; unverified product claims are never promoted.
   contentApproved:false
  };
 });
 return {
  schemaVersion:1,kind:'saas-factory-growth-seo-preview',
  projectSlug:growth.projectSlug,locale,startDate,
  status:'draft-only',analyticsStatus:'not-integrated',
  audienceEvidence:'unverified',collectionEnabled:false,publicationEnabled:false,
  seoPages:previewPages,
  robots:createRobots({origin}),sitemap:createSitemap({origin}),
  integration:{origin,requiresGeneratedAppAdapter:true,analyticsDependency:'#41',
   completeGrowthDependency:'#65',seoDependency:'#44',
   automaticPublishing:false,automaticTracking:false},
  note:'Neutral SEO metadata is not a certified or published product marketing page.'
 };
}
function exportGrowthSeoPreview(preview,format='json'){
 if(!preview||preview.kind!=='saas-factory-growth-seo-preview'||preview.status!=='draft-only')
  throw Error('Only draft Growth SEO previews can be exported');
 if(format==='json')return JSON.stringify(preview,null,2)+'\n';
 if(format!=='markdown')throw Error('Unsupported export format');
 const escape=value=>String(value).replace(/[&<>|]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','|':'\\|'}[c]))
  .replace(/[\r\n\t]/g,' ');
 return [
  '# Growth SEO preview (draft-only)', '',
  'Project: '+escape(preview.projectSlug),'Locale: '+escape(preview.locale),'',
  ...preview.seoPages.map(p=>'- '+escape(p.metadata.canonical)+' — '+escape(p.metadata.title)+' (draft)'),
  '', 'No publishing, consent tracking, lead collection or real integrations.',''
 ].join('\n');
}
export {createGrowthSeoPreview,exportGrowthSeoPreview};
