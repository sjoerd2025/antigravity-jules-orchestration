import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

let db;

export const DB_PATH = process.env.SQLITE_DB_PATH || './antigravity.sqlite';

export async function getDb() {
  if (db) return db;

  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  await db.exec('PRAGMA journal_mode = WAL;');

  return db;
}