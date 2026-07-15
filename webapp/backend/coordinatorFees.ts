import * as bitcoin from 'bitcoinjs-lib';

export interface CoordinatorFeeConfig {
    makerFeePercent: string;
    takerFeePercent: string;
    receiveAddress: string;
}

interface ParsedPercent {
    numerator: bigint;
    denominator: bigint;
}

function parsePercent(name: string, value: string | undefined): ParsedPercent {
    const normalized = (value ?? '0').trim();
    const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
    if (!match) throw new Error(`${name} must be a number between 0 and 100`);

    const decimals = match[2] ?? '';
    const denominator = 100n * (10n ** BigInt(decimals.length));
    const numerator = BigInt(match[1]) * (10n ** BigInt(decimals.length)) + BigInt(decimals || '0');
    if (numerator > denominator) throw new Error(`${name} must be a number between 0 and 100`);
    return { numerator, denominator };
}

export function loadCoordinatorFeeConfig(env: NodeJS.ProcessEnv = process.env): CoordinatorFeeConfig {
    const makerFeePercent = (env.MAKER_FEE_PERCENT ?? '0').trim();
    const takerFeePercent = (env.TAKER_FEE_PERCENT ?? '0').trim();
    const receiveAddress = (env.COORDINATOR_RECEIVE_ADDR ?? '').trim();
    const maker = parsePercent('MAKER_FEE_PERCENT', makerFeePercent);
    const taker = parsePercent('TAKER_FEE_PERCENT', takerFeePercent);
    if ((maker.numerator > 0n || taker.numerator > 0n) && !receiveAddress) {
        throw new Error('COORDINATOR_RECEIVE_ADDR is required when coordinator fees are enabled');
    }
    return { makerFeePercent, takerFeePercent, receiveAddress };
}

export function requiredCoordinatorFee(amountSats: bigint, percent: string): bigint {
    if (amountSats < 0n) throw new Error('Swap amount cannot be negative');
    const parsed = parsePercent('fee percent', percent);
    return (amountSats * parsed.numerator + parsed.denominator - 1n) / parsed.denominator;
}

export function coordinatorOutputValue(
    rawTransactionHex: string,
    receiveAddress: string,
    network: bitcoin.Network
): bigint {
    const transaction = bitcoin.Transaction.fromHex(rawTransactionHex);
    const receiveScript = bitcoin.address.toOutputScript(receiveAddress, network);
    return transaction.outs.reduce(
        (total, output) => Buffer.from(output.script).equals(receiveScript) ? total + output.value : total,
        0n
    );
}

export function assertCoordinatorFee(
    rawTransactionHex: string,
    swapAmountSats: bigint,
    percent: string,
    receiveAddress: string,
    network: bitcoin.Network
): void {
    const required = requiredCoordinatorFee(swapAmountSats, percent);
    if (required === 0n) return;
    const paid = coordinatorOutputValue(rawTransactionHex, receiveAddress, network);
    if (paid < required) {
        throw new Error(`Coordinator fee underpaid: required at least ${required} sats, found ${paid} sats`);
    }
}
