export interface Outpoint {
    txid: string;
    vout: number;
}

export type UtxoClassification = 'unsplit' | 'split';

export const outpointKey = (utxo: Outpoint): string => `${utxo.txid}:${utxo.vout}`;

export const buildOutpointSet = (utxos: Outpoint[]): Set<string> => (
    new Set(utxos.map(outpointKey))
);

export const classifyOutpoint = (
    utxo: Outpoint,
    mainChainOutpoints: ReadonlySet<string>,
    bip110ChainOutpoints: ReadonlySet<string>
): UtxoClassification => {
    const key = outpointKey(utxo);
    return mainChainOutpoints.has(key) && bip110ChainOutpoints.has(key)
        ? 'unsplit'
        : 'split';
};
