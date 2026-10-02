import { getDatabase } from '@netlify/database';
import { createAPI } from '../../server/core.mjs';
export default async function handler(request,context) {
  // A request owns one lazy pool. Serverless WebSocket connections must not
  // escape the request; status checks need no database connection at all.
  let connection;
  const database = () => connection ??= getDatabase();
  const db = {
    query: (text,values) => database().pool.query(text,values),
    transaction: async fn => {
      const client = await database().pool.connect();
      try { await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); const result = await fn(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
  };
  try {
    return await createAPI({db,hostPassword:process.env.HOST_PASSWORD})(request,{ip:context.ip || 'unknown'});
  } finally {
    if(connection) await connection.pool.end();
  }
}
export const config = { path: '/api/*' };
