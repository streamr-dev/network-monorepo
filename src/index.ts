import { StreamrClient } from './StreamrClient'

export * from './StreamrClient'
export * from './Config'
export * from './stream'
export * from './stream/Encryption'
export * from './stream/StreamPart'
export * from './stream/StorageNode'
export * from './subscribe'
export * from './rest/LoginEndpoints'
export * from './rest/StreamEndpoints'
export * from './dataunion/DataUnion'
export * from './rest/authFetch'
export * from './types'

// TODO should export these to support StreamMessageAsObject:
// export {
//   StreamMessageType, ContentType, EncryptionType, SignatureType
// } from 'streamr-client-protocol/dist/src/protocol/message_layer/StreamMessage'
export { BigNumber } from '@ethersproject/bignumber'
export { ConnectionInfo } from '@ethersproject/web'
export { Contract } from '@ethersproject/contracts'
export { TransactionReceipt, TransactionResponse } from '@ethersproject/providers'

export default StreamrClient

// Note awful export wrappers in index-commonjs.js & index-esm.mjs
