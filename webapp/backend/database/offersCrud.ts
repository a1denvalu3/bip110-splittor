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
    secondLockTime?: number | null;
    b110HtlcAddress?: string | null;
    btcHtlcAddress?: string | null;
    b110HtlcTxid?: string | null;
    btcHtlcTxid?: string | null;
    b110HtlcVout?: number | null;
    btcHtlcVout?: number | null;
    initiatorSettlementTxid?: string | null;
    acceptorSettlementTxid?: string | null;
    preimage?: string | null;
    networkMode: 'mainnet' | 'regtest';
    createdAt: number;
    backingTxid?: string | null;
    backingVout?: number | null;
    backingChain?: 'main' | 'bip110' | null;
    acceptorClaimed?: number; // 0 or 1
}

export interface GetOffersOptions {
    page?: number;
    limit?: number;
    orderBy?: 'premium' | 'amount' | 'createdAt';
    orderDir?: 'asc' | 'desc';
    excludePubKey?: string;
    initiatorPubKey?: string;
    acceptorPubKey?: string;
}

export interface PaginatedOffers {
    offers: DbOffer[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}

export async function getOffersByMode(
    mode: 'mainnet' | 'regtest',
    options: GetOffersOptions = {}
): Promise<PaginatedOffers> {
    const page = options.page && options.page > 0 ? Number(options.page) : 1;
    const limit = options.limit && options.limit > 0 ? Number(options.limit) : 10;
    const offset = (page - 1) * limit;

    const allowedOrderBy = ['premium', 'amount', 'createdAt'];
    const allowedOrderDir = ['asc', 'desc'];

    const orderField = options.orderBy && allowedOrderBy.includes(options.orderBy) ? options.orderBy : 'createdAt';
    const orderDirection = options.orderDir && allowedOrderDir.includes(options.orderDir) ? options.orderDir : 'desc';

    let sqlOrderBy = '';
    if (orderField === 'premium') {
        sqlOrderBy = `CASE WHEN backingChain = 'main' THEN ((initiatorB110Amount * 1.0 / acceptorBtcAmount) - 1.0) * 100.0
                           ELSE ((acceptorBtcAmount * 1.0 / initiatorB110Amount) - 1.0) * 100.0
                      END`;
    } else if (orderField === 'amount') {
        sqlOrderBy = `CASE WHEN backingChain = 'main' THEN acceptorBtcAmount ELSE initiatorB110Amount END`;
    } else {
        sqlOrderBy = 'createdAt';
    }

    let whereClause = "WHERE networkMode = ?";
    const whereParams: any[] = [mode];

    if (options.excludePubKey) {
        whereClause += " AND initiatorPubKey != ?";
        whereParams.push(options.excludePubKey);
    }
    if (options.initiatorPubKey) {
        whereClause += " AND initiatorPubKey = ?";
        whereParams.push(options.initiatorPubKey);
    }
    if (options.acceptorPubKey) {
        whereClause += " AND acceptorPubKey = ?";
        whereParams.push(options.acceptorPubKey);
    }

    const countResult = await dbGet(
        `SELECT COUNT(*) as count FROM offers ${whereClause}`,
        whereParams
    );
    const total = countResult ? countResult.count : 0;

    const queryParams = [...whereParams, limit, offset];
    const offers = await dbAll(
        `SELECT * FROM offers ${whereClause} ORDER BY ${sqlOrderBy} ${orderDirection.toUpperCase()} LIMIT ? OFFSET ?`,
        queryParams
    );

    return {
        offers,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
    };
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
    secondLockTime: number;
    networkMode: 'mainnet' | 'regtest';
    backingTxid?: string | null;
    backingVout?: number | null;
    backingChain?: 'main' | 'bip110' | null;
}): Promise<void> {
    const createdAt = Date.now();
    await dbRun(`
        INSERT INTO offers (
            id, status, initiatorPubKey, initiatorB110Amount, acceptorPubKey, acceptorBtcAmount,
            hashLock, lockTime, secondLockTime, b110HtlcAddress, btcHtlcAddress, b110HtlcTxid, btcHtlcTxid, b110HtlcVout, btcHtlcVout,
            initiatorSettlementTxid, acceptorSettlementTxid, preimage, networkMode, createdAt, backingTxid, backingVout, backingChain, acceptorClaimed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `, [
        offer.id, 'OPEN', offer.initiatorPubKey, offer.initiatorB110Amount, null, offer.acceptorBtcAmount,
        offer.hashLock, offer.lockTime, offer.secondLockTime, null, null, null, null, null, null,
        null, null, null, offer.networkMode, createdAt, offer.backingTxid || null,
        offer.backingVout !== undefined ? offer.backingVout : null, offer.backingChain || null
    ]);
}

export async function acceptOfferById(id: string, acceptorPubKey: string): Promise<boolean> {
    const result = await dbRun(
        "UPDATE offers SET acceptorPubKey = ?, status = 'ACCEPTED' WHERE id = ? AND status = 'OPEN'",
        [acceptorPubKey, id]
    );
    return result.changes === 1;
}

export async function updateOfferFieldsById(id: string, fields: Partial<DbOffer>): Promise<void> {
    const updates: string[] = [];
    const params: any[] = [];

    const allowedKeys: (keyof DbOffer)[] = [
        'status', 'acceptorPubKey', 'b110HtlcAddress', 'btcHtlcAddress',
        'b110HtlcTxid', 'btcHtlcTxid', 'b110HtlcVout', 'btcHtlcVout', 'initiatorSettlementTxid',
        'acceptorSettlementTxid', 'preimage', 'acceptorClaimed'
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
