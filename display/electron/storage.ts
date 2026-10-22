import initSqlJs, {type Database} from 'sql.js';
import {safeStorage} from 'electron';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import type {Saved,Store} from '../src/core/types.js';
const require=createRequire(import.meta.url);
export class SecureSqliteStore implements Store {
 private constructor(private db:Database,private path:string){}
 static async open(directory:string){await mkdir(directory,{recursive:true});const SQL=await initSqlJs({locateFile:()=>require.resolve('sql.js/dist/sql-wasm.wasm')});const path=join(directory,'display-cache.sqlite');let db:Database;try{db=new SQL.Database(await readFile(path));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')await rename(path,path+'.corrupt-'+Date.now()).catch(()=>{});db=new SQL.Database();}db.run('CREATE TABLE IF NOT EXISTS cache (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)');return new SecureSqliteStore(db,path);}
 async load():Promise<Saved|null>{try{const rows=this.db.exec('SELECT payload FROM cache WHERE id=1');if(!rows[0]?.values.length)return null;const saved=JSON.parse(String(rows[0].values[0][0])) as Saved;if(saved.deviceToken){if(!safeStorage.isEncryptionAvailable())throw Error('当前用户安全存储不可用');saved.deviceToken=safeStorage.decryptString(Buffer.from(saved.deviceToken,'base64'));}return saved;}catch{return null;}}
 async save(value:Saved){const saved=structuredClone(value);if(saved.deviceToken){if(!safeStorage.isEncryptionAvailable())throw Error('当前用户安全存储不可用，无法保存设备授权');saved.deviceToken=safeStorage.encryptString(saved.deviceToken).toString('base64');}this.db.run('INSERT INTO cache(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',[JSON.stringify(saved)]);const temporary=this.path+'.tmp';await writeFile(temporary,this.db.export(),{mode:0o600});await rename(temporary,this.path);}
}
