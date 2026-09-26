import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {seal,tokenKey} from '../../worker/self-service/crypto.mjs';
export async function seedGoogleCredential(ctx,sub='alice'){
 await ctx.db.batch([ctx.db.prepare('INSERT INTO users(sub,created_at) VALUES (?,?) ON CONFLICT DO NOTHING').bind(sub,ctx.now()),ctx.db.prepare('INSERT OR REPLACE INTO google_credentials VALUES (?,?,?)').bind(sub,await seal('fixture-refresh',tokenKey(ctx),'google:'+sub),ctx.now())]);
}
export async function googleFixture({now=Date.now,sub='alice'}={}){
 const {publicKey,privateKey}=await generateKeyPair('RS256');const jwks={keys:[{...(await exportJWK(publicKey)),kid:'fixture'}]};const codes=new Map();const calls=[];
 const token=async(nonce,extra={})=>new SignJWT({nonce,...extra}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer('https://accounts.google.com').setAudience('fixture-client').setSubject(sub).setIssuedAt(Math.floor(now()/1000)).setExpirationTime(Math.floor(now()/1000)+300).sign(privateKey);
 const authorize=async url=>{const u=new URL(url),code=crypto.randomUUID();codes.set(code,await token(u.searchParams.get('nonce')));return code;};
 const fetchImpl=async(input,init={})=>{const u=new URL(input instanceof Request?input.url:input);calls.push({url:u.toString(),method:init.method??'GET'});
  if(u.hostname==='challenges.cloudflare.com')return Response.json({success:true,hostname:'meo.test',action:'self_start'});
  if(u.pathname==='/oauth2/v3/certs')return Response.json(jwks);
  if(u.hostname==='oauth2.googleapis.com'){const form=new URLSearchParams(init.body);if(form.get('grant_type')==='refresh_token')return Response.json({access_token:'fixture-access',expires_in:3600});const id=codes.get(form.get('code'));if(!id)return Response.json({error:'invalid_grant'},{status:400});return Response.json({id_token:id,access_token:'fixture-access',refresh_token:'fixture-refresh',scope:'openid https://www.googleapis.com/auth/business.manage'});}
  throw new Error('UNEXPECTED_PROVIDER_CALL:'+u.pathname);
 };return {jwks,token,authorize,fetchImpl,calls,codes};
}
