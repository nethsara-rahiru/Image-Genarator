import path from 'node:path';import fs from 'node:fs/promises';import crypto from 'node:crypto';import {AppError} from './errors.js';
export function safePath(root,name){if(!/^[a-zA-Z0-9_.-]+$/.test(name)||name==='.'||name==='..')throw new AppError('PATH','Invalid storage name');const p=path.resolve(root,name);if(path.dirname(p)!==path.resolve(root))throw new AppError('PATH','Invalid path');return p;}
export async function storage(config){for(const p of ['profiles','uploads','outputs','monitor'])await fs.mkdir(path.join(config.DATA_DIR,p),{recursive:true,mode:0o700});}
export const checksum=b=>crypto.createHash('sha256').update(b).digest('hex');
export const cleanName=s=>path.basename(s).replace(/[^a-zA-Z0-9_. -]/g,'_').slice(0,120);
export function chatUrl(value){const u=new URL(value);if(u.origin!=='https://gemini.google.com'||!/^\/app\/[a-zA-Z0-9_-]+$/.test(u.pathname)||u.search||u.hash)throw new AppError('CHAT_URL','Invalid Gemini conversation URL');return u.href;}
