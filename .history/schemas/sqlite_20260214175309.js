import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

let db;

export async function getDb() {
  if (db) return db;

  db = await open({
    filename: process.env.SQLITE_DB_PATH || './antigravity.sqlite',
    driver: sqlite3.Database
  });

  return db;
}