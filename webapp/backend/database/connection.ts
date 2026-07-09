import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';

// Store DB in the webapp directory so it persists across container rebuilds or restarts
const dbPath = path.resolve(__dirname, '../bip110_swap.db');

// Check if starting in regtest mode to start everything from zero
const args = process.argv.slice(2);
const isRegtest = !(
    args.includes('--mainnet') || 
    args.includes('--network=mainnet') || 
    process.env.NETWORK_MODE === 'mainnet'
);

if (isRegtest) {
    console.log("[DB] Regtest mode detected. Wiping local database to start fresh from zero...");
    try {
        if (fs.existsSync(dbPath)) {
            fs.unlinkSync(dbPath);
            console.log("[DB] Existing database file deleted successfully.");
        }
    } catch (err: any) {
        console.error("[DB] Failed to wipe existing database file:", err.message);
    }
}

export const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("[DB] Failed to connect to SQLite database:", err.message);
    } else {
        console.log(`[DB] Connected to SQLite database at: ${dbPath}`);
    }
});

export const dbRun = (sql: string, params: any[] = []): Promise<void> => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve();
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
