import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

export const root = new URL('../../', import.meta.url);
const identifier = value => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('Invalid identifier');
  return '"' + value + '"';
};
// Auth session issuance and transport are simulated. PostgreSQL RPCs, permissions,
// triggers, storage limits, password hashing and cascades are the real application SQL.
export async function createDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
    $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;`);
  const schema = await readFile(new URL('supabase/open-dictionary.sql',root),'utf8');
  await db.exec(schema);
  async function asUser(userId, sql, args = [], role = 'authenticated') {
    return db.transaction(async tx => {
      await tx.exec('set local role ' + identifier(role));
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[userId || '']);
      return tx.query(sql,args);
    });
  }
  async function execute(userId, request) {
    try {
      const params = Object.values(request.args || {});
      const args = Object.keys(request.args || {}).map((key,index) => `${identifier(key)} => $${index+1}`).join(',');
      const result = await asUser(userId,`select public.${identifier(request.rpc)}(${args}) as result`,params);
      return { data: result.rows[0].result, error: null };
    } catch(error) { return { data: null, error: { message: error.message, code: error.code } }; }
  }
  async function newUser() {
    const id = randomUUID(); await db.query('insert into auth.users(id) values($1)',[id]); return id;
  }
  return { db, schema, execute, asUser, newUser };
}
export function installTestClient(userId) {
  window.supabase = { createClient() { return {
    rpc: (rpc,args) => window.__database({rpc,args}),
    auth: {
      getUser: async () => ({data:{user:{id:userId}},error:null}),
      getSession: async () => ({data:{session:{user:{id:userId}}},error:null}),
      signInAnonymously: async () => ({data:{user:{id:userId}},error:null})
    }
  }; } };
}
export async function createApi(database,userId) {
  const sandbox = {window:{APP_CONFIG:{supabaseUrl:'https://test.invalid',supabasePublishableKey:'test'}},console};
  sandbox.window.__database = request => database.execute(userId,request);
  vm.createContext(sandbox);
  vm.runInContext(`(${installTestClient.toString()})('${userId}')`,sandbox);
  vm.runInContext(await readFile(new URL('site/supabase-api.js',root),'utf8'),sandbox);
  await sandbox.window.AppApi.init();
  return (name,...args) => sandbox.window.AppApi.call(name,...args);
}
