import sqlite3 from 'sqlite3';
import path from 'path';

// Store DB in the webapp directory so it persists across container rebuilds or restarts
const args = process.argv.slice(2);
const isMainnet = args.includes('--mainnet') || args.includes('--network=mainnet') || process.env.NETWORK_MODE === 'mainnet';
const dbName = isMainnet ? 'bip110_swap_mainnet.db' : 'bip110_swap_regtest.db';
const dbPath = path.resolve(__dirname, `../${dbName}`);

export const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("[DB] Failed to connect to SQLite database:", err.message);
    } else {
        console.log(`[DB] Connected to SQLite database at: ${dbPath}`);
    }
});

export interface DbRunResult { changes: number; lastID: number }
export const dbRun = (sql: string, params: any[] = []): Promise<DbRunResult> => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
};

export const dbAll = (sql: string, params: any[] = []): Promise<any[]> => {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

export const dbGet = (sql: string, params: any[] = []): Promise<any> => {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};
