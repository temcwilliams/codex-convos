import {randomBytes,createHash,scryptSync,timingSafeEqual} from 'node:crypto';
export const token=()=>randomBytes(32).toString('base64url');
export const digest=s=>createHash('sha256').update(String(s||'')).digest('hex');
export const equal=(a,b)=>timingSafeEqual(Buffer.from(digest(a)),Buffer.from(digest(b)));
export function passwordHash(password){const salt=token();return salt+':'+scryptSync(password,salt,64).toString('hex')}
export function passwordMatches(password,hash){const [salt,value]=hash.split(':');return timingSafeEqual(scryptSync(password,salt,64),Buffer.from(value,'hex'))}
export const publicUser=({id,name,email,role})=>({id,name,email,role});
