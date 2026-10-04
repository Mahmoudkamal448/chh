// The fork's bundled typings aren't reachable through its package "exports"; it is API-compatible
// with better-sqlite3, so reuse those types.
declare module 'better-sqlite3-multiple-ciphers' {
  import Database from 'better-sqlite3';
  export = Database;
}
