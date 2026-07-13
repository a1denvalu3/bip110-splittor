import { outpointKey, Outpoint } from './utxoClassification';

export interface FundingCandidate extends Outpoint {
    amount: number;
}

export interface FundingSelection<T extends FundingCandidate> {
    utxos: T[];
    totalInputSats: bigint;
    feeSats: bigint;
    hasChange: boolean;
}

export type FundingFeeEstimator = (inputCount: number, hasChange: boolean) => number;

export const selectFundingUtxos = <T extends FundingCandidate>(
    candidates: T[],
    targetSats: bigint,
    estimateFee: FundingFeeEstimator,
    preferredOutpoint?: Outpoint,
    changeDustSats = 546n
): FundingSelection<T> | null => {
    const unique = candidates.filter(
        (candidate, index, list) => list.findIndex(item => outpointKey(item) === outpointKey(candidate)) === index
    );
    const preferredKey = preferredOutpoint ? outpointKey(preferredOutpoint) : undefined;
    const preferred = preferredKey ? unique.find(candidate => outpointKey(candidate) === preferredKey) : undefined;
    const remainder = unique
        .filter(candidate => !preferred || outpointKey(candidate) !== outpointKey(preferred))
        .sort((a, b) => b.amount - a.amount);
    const ordered = preferred ? [preferred, ...remainder] : remainder;

    const selected: T[] = [];
    let totalInputSats = 0n;

    for (const utxo of ordered) {
        selected.push(utxo);
        totalInputSats += BigInt(utxo.amount);

        const noChangeFee = BigInt(estimateFee(selected.length, false));
        if (totalInputSats < targetSats + noChangeFee) continue;

        const withChangeFee = BigInt(estimateFee(selected.length, true));
        const hasChange = totalInputSats >= targetSats + withChangeFee + changeDustSats;
        const feeSats = hasChange ? withChangeFee : noChangeFee;

        if (totalInputSats >= targetSats + feeSats) {
            return { utxos: selected, totalInputSats, feeSats, hasChange };
        }
    }

    return null;
};
