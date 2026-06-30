import { PureBitcoinSwap } from './src/lib/PureBitcoinSwap';
import * as bitcoin from 'bitcoinjs-lib';

function printScriptAsm(name: string, script: Buffer) {
    const decompiled = bitcoin.script.decompile(script)!;
    const asm = decompiled.map(token => {
        if (Buffer.isBuffer(token)) {
            return `<${token.toString('hex')}>`;
        }
        return bitcoin.script.OPS[token as number] || `0x${(token as number).toString(16)}`;
    }).join(' ');

    console.log(`\n==================================================`);
    console.log(`CONTRACT LEAF: ${name}`);
    console.log(`==================================================`);
    console.log(`Compiled Hex (${script.length} bytes):\n  ${script.toString('hex')}`);
    console.log(`\nDecoded ASM (Bitcoin Opcodes):\n  ${asm}`);
}

// Generate some mock keys and parameters to display the compiled script opcodes
const mockKey = Buffer.from('0250863ad64a87ae8a2fe83c1af1a8403cb53f53e486d8511dad8a04887e5b2352', 'hex');
const mockHashLock = Buffer.from('4a942fa7068fc59ee7eda43ad905aadbffc800206c266b30e6a1319c66dc401e', 'hex');
const lockTime = 2000;

printScriptAsm('SplitContract (Main-Chain Gating Leaf)', PureBitcoinSwap.createSplitScript(mockKey));
printScriptAsm('ClaimLeaf (HTLC Swap Success Path)', PureBitcoinSwap.createHtlcClaimScript(mockHashLock, mockKey));
printScriptAsm('RefundLeaf (HTLC Swap Timeout Path)', PureBitcoinSwap.createHtlcRefundScript(mockKey, lockTime));
