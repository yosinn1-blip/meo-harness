const enc=new TextEncoder();const dec=new TextDecoder();
export function base64(bytes){return btoa(String.fromCharCode(...bytes));}
export function decode64(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
export function randomToken(size=32){return base64(crypto.getRandomValues(new Uint8Array(size))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');}
export async function sha256(s){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(s))),v=>v.toString(16).padStart(2,'0')).join('');}
export async function hmac(s,key){const k=await crypto.subtle.importKey('raw',enc.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);return base64(new Uint8Array(await crypto.subtle.sign('HMAC',k,enc.encode(s))));}
export function tokenKey(ctx){return decode64(ctx.env.SELF_TOKEN_KEY_V1);}
export function safeEqual(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
export async function seal(text,key,context){const iv=crypto.getRandomValues(new Uint8Array(12));const k=await crypto.subtle.importKey('raw',key,'AES-GCM',false,['encrypt']);const c=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode('v1:'+context)},k,enc.encode(text));return JSON.stringify({v:1,iv:base64(iv),c:base64(new Uint8Array(c))});}
export async function unseal(envelope,key,context){const b=JSON.parse(envelope);if(b.v!==1)throw new Error('UNKNOWN_KEY_VERSION');const k=await crypto.subtle.importKey('raw',key,'AES-GCM',false,['decrypt']);return dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(b.iv),additionalData:enc.encode('v1:'+context)},k,decode64(b.c)));}
