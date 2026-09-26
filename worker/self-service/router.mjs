import {getSelfStatus} from './status.mjs';import {readSession,createSession,requireActor,requireMutation} from './session.mjs';import {discoverLocations,selectLocation} from './locations.mjs';import {readBody} from './abuse.mjs';import {SelfError,publicError} from './errors.mjs';
export function selfJson(data,status=200,headers={}){return Response.json(data,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',...headers}});}
export async function handleSelfRequest(request,env,ctx){
 const u=new URL(request.url);if(!u.pathname.startsWith('/api/self/'))return null;
 try{
  if(!ctx.db)throw new SelfError('REGISTRATION_CLOSED',503);
  if(u.pathname==='/api/self/status'&&request.method==='GET'){
   let s=await readSession(ctx,request);if(!s){s=await createSession(ctx,null);return selfJson({...await getSelfStatus(ctx,request),csrf:s.csrf},200,{'Set-Cookie':s.cookie});}return selfJson(await getSelfStatus(ctx,request));
  }
  const actor=request.method==='POST'?await requireMutation(ctx,request):await requireActor(ctx,request);
  if(u.pathname==='/api/self/locations'&&request.method==='GET')return selfJson({ok:true,...await discoverLocations(ctx,actor,{cursor:u.searchParams.get('cursor')})});
  if(u.pathname==='/api/self/location'&&request.method==='POST'){await selectLocation(ctx,actor,await readBody(request));return selfJson({ok:true});}
  throw new SelfError('NOT_FOUND',404);
 }catch(e){return selfJson(publicError(e),e instanceof SelfError?e.status:500);}
}
