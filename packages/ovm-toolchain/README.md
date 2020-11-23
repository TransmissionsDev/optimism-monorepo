# @eth-optimism/ovm-toolchain

`@eth-optimism/ovm-toolchain` provides "OVM-ified" wrappers or plugins for common Ethereum developer tools. Currently, this package directly or indirectly enables OVM execution within the following tools:

* [buidler](https://buidler.dev)
* [waffle](https://ethereum-waffle.readthedocs.io/en/latest/)
* [ganache](https://github.com/trufflesuite/ganache-core)
* [ethers](https://docs.ethers.io)

## Usage

### ganache

`ovm-toolchain` exports a `ganache` object which behaves identically to the one exported by [`ganache-core`](https://github.com/trufflesuite/ganache-core). However, we hijack the `ganache` instance such that the resulting `provider` object is backed by our own [`ethereumjs-vm` fork](https://github.com/ethereum-optimism/ethereumjs-vm) instead of the canonical version.

Import our `ganache` object as follows:

```typescript
import { ganache } from '@eth-optimism/ovm-toolchain'

const provider = ganache.provider(options) // Same options as `ganache-core`.
```

Please refer to the [`ganache-core` README](https://github.com/trufflesuite/ganache-core/blob/develop/README.md) for information about using and configuring `ganache`.

### waffleV2/waffleV3

`ovm-toolchain` exports two `waffle` objects, `waffleV2` and `waffleV3`, one for each major version of `waffle`. Each object has a single field (`MockProvider`) that can replace the `MockProvider` import from `ethereum-waffle`.

Import these objects as follows:

```typescript
import { waffleV2, waffleV3 } from '@eth-optimism/ovm-toolchain'

const providerV2 = new waffleV2.MockProvider(options) // Same options as V2 waffle MockProvider.
const providerV3 = new waffleV3.MockProvider({
    ganacheOptions: options,                          // Same options as V3 waffle MockProvider.
})
```

Please refer to the [`waffle` docs](https://ethereum-waffle.readthedocs.io/en/latest/index.html) for more information.

### buidler

`ovm-toolchain` provides two `builder` plugins, `buidler-ovm-compiler` and `buidler-ovm-node`.

#### buidler-ovm-compiler
`buidler-ovm-compiler` allows users to specify a custom compiler `path` within `buidler.config.ts`. This makes it possible to compile your contracts with our [custom Solidity compiler](https://github.com/ethereum-optimism/solidity).

Import `buidler-ovm-compiler` as follows:

```typescript
// buidler.config.ts

import '@eth-optimism/ovm-toolchain/build/src/buidler-plugins/buidler-ovm-compiler'

const config = {
  solc: {
    path: '@eth-optimism/solc',
  },
}

export default config
```

#### buidler-ovm-node
`buidler-ovm-node` performs a hijack similar to the one performed for `ganache` in order to replace the VM object with our own custom `ethereumjs-vm` fork. Add `useOvm` to your buidler config object to enable OVM execution.

Import `buidler-ovm-node` as follows:

```typescript
// buidler.config.ts

import '@eth-optimism/ovm-toolchain/build/src/buidler-plugins/buidler-ovm-node'

const config = {
  useOvm: true,
}

export default config
```

#### Watcher
Our `Watcher` allows you to retrieve all transaction hashes related to cross domain messages such as deposits and withdrawals. In order to use, first send a transaction which sends a cross domain message, for example a deposit from L1 into L2. After sending the deposit transaction and storing the transaction hash, use `getMessageHashesFromL1Tx(l1TxHash)` to get an array of the message hashes of all of the L1->L2 messages that were sent inside of that L1 tx (This will usually just be a single element array, but it can return multiple if one L1 transaction triggers multiple deposits). `getMessageHashesFromL2Tx(l2TxHash)` does the same for L2->L1 messages. `onceL2Relay(messageHash, callback)` takes in an L1->L2 message hash and a callback that will be triggered after 2-5 minutes with the hash of the L2 tx that the message ends up getting relayed in. `onceL1Relay(messageHash, callback)` does the same for L2->L1 messages, except the delay is 7 days.

```typescript
import { Watcher } from '@eth-optimism/ovm-toolchain/'
import { JsonRpcProvider } from 'ethers/providers'

const watcher = new Watcher({
  l1: {
    provider: new JsonRpcProvider('INFURA_L1_URL'),
    messengerAddress: '0x...'
  },
  l2: {
    provider: new JsonRpcProvider('OPTIMISM_L2_URL'),
    messengerAddress: '0x...'
  }
})
const l1TxHash = (await depositContract.deposit(100)).hash
const [messageHash] = await watcher.getMessageHashesFromL1Tx(l1TxHash)
console.log('L1->L2 message hash:', messageHash)
watcher.onceL2Relay(messageHash, (l2txhash) => {
  // Takes 2-5 minutes
  console.log('Got L2 Tx Hash:', l2txhash)
})
```