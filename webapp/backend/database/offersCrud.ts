import { dbAll, dbRun, dbGet } from './connection';

export interface DbOffer {
    id: string;
    status: 'OPEN' | 'ACCEPTED' | 'FUNDED_INITIATOR' | 'FUNDED_ACCEPTOR' | 'CLAIMED' | 'REFUNDED';
    initiatorPubKey: string;
    initiatorB110Amount: number;
    acceptorPubKey?: string | null;
    acceptorBtcAmount: number;
    hashLock: string;
    lockTime: number;
    b110HtlcAddress?: string | null;
    btcHtlcAddress?: string | null;
    b110HtlcTxid?: string | null;
    btcHtlcTxid?: string | null;
    preimage?: string | null;
    networkMode: 'mainnet' | 'regtest';
    createdAt: number;
    backingTxid?: string | null;
    backingVout?: number | null;
    backingChain?: 'main' | 'bip110' | null;
    acceptorClaimed?: number; // 0 or 1
}

export async function getOffersByMode(mode: 'mainnet' | 'regtest'): Promise<DbOffer[]> {
    return dbAll(
        "SELECT * FROM offers WHERE networkMode = ? ORDER BY createdAt DESC",
        [mode]
    );
}

export async function getOfferById(id: string): Promise<DbOffer | null> {
    const offer = await dbGet("SELECT * FROM offers WHERE id = ?", [id]);
    return offer || null;
}

export async function insertOffer(offer: {
    id: string;
    initiatorPubKey: string;
    initiatorB110Amount: number;
    acceptorBtcAmount: number;
    hashLock: string;
    lockTime: number;
    networkMode: 'mainnet' | 'regtest';
    backingTxid?: string | null;
    backingVout?: number | null;
    backingChain?: 'main' | 'bip110' | null;
}): Promise<void> {
    const createdAt = Date.now();
    await dbRun(`
        INSERT INTO offers (
            id, status, initiatorPubKey, initiatorB110Amount, acceptorPubKey, acceptorBtcAmount,
            hashLock, lockTime, b110HtlcAddress, btcHtlcAddress, b110HtlcTxid, btcHtlcTxid,
            preimage, networkMode, createdAt, backingTxid, backingVout, backingChain, acceptorClaimed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `, [
        offer.id, 'OPEN', offer.initiatorPubKey, offer.initiatorB110Amount, null, offer.acceptorBtcAmount,
        offer.hashLock, offer.lockTime, null, null, null, null,
        null, offer.networkMode, createdAt, offer.backingTxid || null, 
        offer.backingVout !== undefined ? offer.backingVout : null, offer.backingChain || null
    ]);
}

export async function acceptOfferById(id: string, acceptorPubKey: string): Promise<void> {
    await dbRun(
        "UPDATE offers SET acceptorPubKey = ?, status = 'ACCEPTED' WHERE id = ?",
        [acceptorPubKey, id]
    );
}

export async function updateOfferFieldsById(id: string, fields: Partial<DbOffer>): Promise<void> {
    const updates: string[] = [];
    const params: any[] = [];

    const allowedKeys: (keyof DbOffer)[] = [
        'status', 'acceptorPubKey', 'b110HtlcAddress', 'btcHtlcAddress',
        'b110HtlcTxid', 'btcHtlcTxid', 'preimage', 'acceptorClaimed'
    ];

    for (const key of allowedKeys) {
        if (fields[key] !== undefined) {
            updates.push(`${key} = ?`);
            if (key === 'acceptorClaimed') {
                params.push(fields[key] ? 1 : 0);
            } else {
                params.push(fields[key]);
            }
        }
    }

    if (updates.length > 0) {
        params.push(id);
        await dbRun(
            `UPDATE offers SET ${updates.join(', ')} WHERE id = ?`,
            params
        );
    }
}

export async function deleteOfferById(id: string): Promise<void> {
    await dbRun("DELETE FROM offers WHERE id = ?", [id]);
}

export async function walkbackAcceptanceById(id: string): Promise<void> {
    await dbRun(
        "UPDATE offers SET status = 'OPEN', acceptorPubKey = NULL WHERE id = ?",
        [id]
    );
}
