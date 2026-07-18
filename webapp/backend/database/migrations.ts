import { dbRun } from './connection';

export async function runMigrations(): Promise<void> {
    console.log("[MIGRATION] Initiating database schema synchronization...");
    try {
        await dbRun(`
            CREATE TABLE IF NOT EXISTS offers (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                initiatorPubKey TEXT NOT NULL,
                initiatorB110Amount INTEGER NOT NULL,
                acceptorPubKey TEXT,
                acceptorBtcAmount INTEGER NOT NULL,
                hashLock TEXT NOT NULL,
                lockTime INTEGER NOT NULL,
                secondLockTime INTEGER,
                b110HtlcAddress TEXT,
                btcHtlcAddress TEXT,
                b110HtlcTxid TEXT,
                btcHtlcTxid TEXT,
                b110HtlcVout INTEGER,
                btcHtlcVout INTEGER,
                initiatorSettlementTxid TEXT,
                acceptorSettlementTxid TEXT,
                preimage TEXT,
                networkMode TEXT NOT NULL,
                createdAt INTEGER NOT NULL,
                backingTxid TEXT,
                backingVout INTEGER,
                backingChain TEXT,
                acceptorClaimed INTEGER DEFAULT 0
            )
        `);
        const additiveColumns = [
            ['secondLockTime', 'INTEGER'],
            ['b110HtlcVout', 'INTEGER'],
            ['btcHtlcVout', 'INTEGER']
            ,['initiatorSettlementTxid', 'TEXT']
            ,['acceptorSettlementTxid', 'TEXT']
        ];
        for (const [name, type] of additiveColumns) {
            try { await dbRun(`ALTER TABLE offers ADD COLUMN ${name} ${type}`); }
            catch (err: any) { if (!String(err.message).includes('duplicate column name')) throw err; }
        }
        console.log("[MIGRATION] Migration checks complete. Offers table verified.");
    } catch (err: any) {
        console.error("[MIGRATION] Critical schema migration failure:", err.message);
        throw err;
    }
}
