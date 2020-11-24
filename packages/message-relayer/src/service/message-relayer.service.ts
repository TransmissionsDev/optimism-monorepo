/* Imports: External */
import { Contract, ethers, Wallet, BigNumber } from 'ethers'
import { JsonRpcProvider } from '@ethersproject/providers'
import { getContractInterface } from '@eth-optimism/contracts'
import * as rlp from 'rlp'
import { MerkleTree } from 'merkletreejs'

/* Imports: Internal */
import { BaseService } from './base.service'
import { sleep } from '../utils/common'
import { Logger } from '../utils/logger'
import { StateBatchHeader, SentMessage, MessageProof } from '../types/ovm.types'

interface MessageRelayerOptions {
  // Providers.
  l1RpcProvider: JsonRpcProvider
  l2RpcProvider: JsonRpcProvider

  // Contract addresses.
  stateCommitmentChainAddress: string
  l1CrossDomainMessengerAddress: string
  l2CrossDomainMessengerAddress: string
  l2ToL1MessagePasserAddress: string

  // Wallet.
  relaySigner: Wallet

  // Optionals.
  l2ChainStartingHeight?: number
  pollingInterval?: number
  blockOffset?: number
}

export class MessageRelayerService extends BaseService<MessageRelayerOptions> {
  private logger = new Logger('Message Relayer')

  private stateCommitmentChain: Contract
  private l1CrossDomainMessenger: Contract
  private l2CrossDomainMessenger: Contract
  private l2ToL1MessagePasser: Contract
  private pollingInterval: number
  private lastFinalizedTxHeight: number
  private nextUnfinalizedTxHeight: number
  private blockOffset: number

  protected async _init(): Promise<void> {
    this.stateCommitmentChain = new Contract(
      this.options.stateCommitmentChainAddress,
      getContractInterface('OVM_StateCommitmentChain'),
      this.options.l1RpcProvider
    )

    this.l1CrossDomainMessenger = new Contract(
      this.options.l1CrossDomainMessengerAddress,
      getContractInterface('OVM_L1CrossDomainMessenger'),
      this.options.l1RpcProvider
    )

    this.l2CrossDomainMessenger = new Contract(
      this.options.l2CrossDomainMessengerAddress,
      getContractInterface('OVM_L2CrossDomainMessenger'),
      this.options.l2RpcProvider
    )

    this.l2ToL1MessagePasser = new Contract(
      this.options.l2ToL1MessagePasserAddress,
      getContractInterface('OVM_L2ToL1MessagePasser'),
      this.options.l2RpcProvider
    )

    this.pollingInterval = this.options.pollingInterval || 5000
    this.lastFinalizedTxHeight = this.options.l2ChainStartingHeight || 0
    this.nextUnfinalizedTxHeight = this.options.l2ChainStartingHeight || 0
    this.blockOffset = this.options.blockOffset || 0

    try {
      await this._sanityChecks()
    } catch (err) {
      this.logger.error(`Sanity check failed: ${err}`)
      throw err
    }
   }

  private async _sanityChecks(): Promise<void> {

    try {
      await this.options.l1RpcProvider.detectNetwork()
    } catch(err) {
      throw err
    }
    try {
      await this.options.l2RpcProvider.detectNetwork()
    } catch(err) {
      throw err
    }

    // TODO: quick check to make sure the provided addresses are correct

    if (this.options.l2ChainStartingHeight < 0) {
      throw "L2 Chain Starting Height must be positive"
    }

    // warnings
    const filter = this.stateCommitmentChain.filters.StateBatchAppended()
    const events = await this.stateCommitmentChain.queryFilter(filter)
    if (events.length === 0) {
      this.logger.info(`Warning: No events exist yet, no state commitment for the given height`)
    }
    if (this.pollingInterval < 15000 || this.pollingInterval > 60000) {
       this.logger.info(`Warning: Polling interval should be greater than 15s or less than an hour`)
     }
  }

  protected async _start(): Promise<void> {
    this.logger.status('Service has started.')

    while (this.running) {
      await sleep(this.pollingInterval)

      this.logger.info('Checking for newly finalized transactions...')
      if (!(await this._isTransactionFinalized(this.nextUnfinalizedTxHeight))) {
        this.logger.info(
          `Didn't find any newly finalized transactions. Trying again in ${Math.floor(
            this.pollingInterval / 1000
          )} seconds...`
        )
        continue
      }

      this.lastFinalizedTxHeight = this.nextUnfinalizedTxHeight
      while (await this._isTransactionFinalized(this.nextUnfinalizedTxHeight)) {
        const size = (await this._getStateBatchHeader(this.nextUnfinalizedTxHeight)).batchSize.toNumber()
        this.logger.info(
          `Found a batch with ${size} finalized transaction(s), checking for more...`
        )
        this.nextUnfinalizedTxHeight += size
      }

      this.logger.interesting(
        `Found a total of ${this.nextUnfinalizedTxHeight - this.lastFinalizedTxHeight} finalized transaction(s).`
      )

      const messages = await this._getSentMessages(
        this.lastFinalizedTxHeight,
        this.nextUnfinalizedTxHeight
      )

      if (messages.length === 0) {
        this.logger.interesting(`Didn't find any L2->L1 messages. Trying again in ${Math.floor(this.pollingInterval / 1000)} seconds...`)
      }

      for (const message of messages) {
        this.logger.interesting(
          `Found a message sent during transaction: ${message.height}`
        )
        if (await this._wasMessageRelayed(message)) {
          this.logger.interesting(`Message has already been relayed, skipping.`)
          continue
        }

        this.logger.interesting(
          `Message not yet relayed. Attempting to generate a proof...`
        )
        const proof = await this._getMessageProof(message)
        this.logger.interesting(
          `Successfully generated a proof. Attempting to relay to Layer 1...`
        )

        try {
          await this._relayMessageToL1(message, proof)
          this.logger.success(`Message successfully relayed to Layer 1!`)
        } catch (err) {
          this.logger.error(
            `Could not relay message to Layer 1, see error log below:\n\n${err}\n`
          )
        }
      }
    }
  }

  protected async _stop(): Promise<void> {
    this.logger.status('Service has stopped.')
  }

  private async _getStateBatchHeader(
    height: number
  ): Promise<StateBatchHeader | undefined> {
    const filter = this.stateCommitmentChain.filters.StateBatchAppended()
    const events = await this.stateCommitmentChain.queryFilter(filter)

    const event = events.find((event) => {
      return (
        event.args._prevTotalElements.toNumber() <= height &&
        event.args._prevTotalElements.toNumber() +
          event.args._batchSize.toNumber() >
          height
      )
    })

    if (!event) {
      return
    }

    const transaction = await this.options.l1RpcProvider.getTransaction(
      event.transactionHash
    )
    const [stateRoots] = this.stateCommitmentChain.interface.decodeFunctionData(
      'appendStateBatch',
      transaction.data
    )

    return {
      batchIndex: event.args._batchIndex,
      batchRoot: event.args._batchRoot,
      batchSize: event.args._batchSize,
      prevTotalElements: event.args._prevTotalElements,
      extraData: event.args._extraData,
      stateRoots: stateRoots,
    }
  }

  private async _isTransactionFinalized(height: number): Promise<boolean> {
    const batch = await this._getStateBatchHeader(height)

    if (batch === undefined) {
      return false
    }

    return !(await this.stateCommitmentChain.insideFraudProofWindow(batch))
  }

  private async _getSentMessages(
    startHeight: number,
    endHeight: number
  ): Promise<SentMessage[]> {
    const filter = this.l2CrossDomainMessenger.filters.SentMessage()
    const events = await this.l2CrossDomainMessenger.queryFilter(
      filter,
      startHeight + this.blockOffset,
      endHeight + this.blockOffset
    )

    return events.map((event) => {
      const message = event.args.message
      const decoded = this.l2CrossDomainMessenger.interface.decodeFunctionData(
        'relayMessage',
        message
      )

      return {
        target: decoded._target,
        sender: decoded._sender,
        data: decoded._message,
        nonce: decoded._messageNonce,
        calldata: message,
        hash: ethers.utils.keccak256(message),
        height: event.blockNumber - this.blockOffset,
      }
    })
  }

  private async _wasMessageRelayed(message: SentMessage): Promise<boolean> {
    return this.l1CrossDomainMessenger.successfulMessages(message.hash)
  }

  private async _getMessageProof(message: SentMessage): Promise<MessageProof> {
    const messageSlot = ethers.utils.keccak256(
      ethers.utils.keccak256(
        message.calldata + this.l2CrossDomainMessenger.address.slice(2)
      ) + '00'.repeat(32)
    )
    var proof
    try {
      proof = await this.options.l2RpcProvider.send('eth_getProof', [
      this.l2ToL1MessagePasser.address,
      [messageSlot],
      BigNumber.from(message.height + this.blockOffset).toHexString(),
      ])
      if (proof === undefined) throw "No proof found"
    } catch (err) {
      this.logger.error(err)
      return
    }

    var batch
    try {
      batch = await this._getStateBatchHeader(message.height)
      if (batch == undefined) throw "No events found in state batch header"
    } catch (err) {
      this.logger.error(err)
      return
    }

    const elements = []
    for (
      let i = 0;
      i < Math.pow(2, Math.ceil(Math.log2(batch.stateRoots.length)));
      i++
    ) {
      if (i < batch.stateRoots.length) {
        elements.push(batch.stateRoots[i])
      } else {
        elements.push('0x' + '00'.repeat(32))
      }
    }

    const hash = (el: Buffer | string): Buffer => {
      return Buffer.from(ethers.utils.keccak256(el).slice(2), 'hex')
    }

    const leaves = elements.map((element) => {
      return hash(element)
    })

    const tree = new MerkleTree(leaves, hash)
    const index = message.height - batch.prevTotalElements.toNumber()
    const treeProof = tree.getProof(leaves[index], index).map((element) => {
      return element.data
    })

    return {
      stateRoot: batch.stateRoots[index],
      stateRootBatchHeader: batch,
      stateRootProof: {
        index: index,
        siblings: treeProof,
      },
      stateTrieWitness: rlp.encode(proof.accountProof),
      storageTrieWitness: rlp.encode(proof.storageProof[0].proof),
    }
  }

  private async _relayMessageToL1(
    message: SentMessage,
    proof: MessageProof
  ): Promise<void> {
    const result = await this.l1CrossDomainMessenger.connect(this.options.relaySigner).relayMessage(
      message.target,
      message.sender,
      message.data,
      message.nonce,
      proof,
      {
        gasLimit: 2_000_000
      }
    )

    return result.wait()
  }
}
