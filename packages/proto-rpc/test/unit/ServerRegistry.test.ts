import { parseWrapper, serializeWrapper } from '../../src/ServerRegistry'
import { RpcMessage } from '../../src/proto/ProtoRpc'

describe('ConversionWrappers', () => {
    const msg: RpcMessage = {
        header: { test: 'testheader' },
        body: new Uint8Array(),
        requestId: '1'
    }

    it('Parses successfully', () => {
        const binary = RpcMessage.toBinary(msg)
        const parsed = parseWrapper<RpcMessage>(() => RpcMessage.fromBinary(binary))
        expect(parsed.requestId).toEqual('1')
    })

    it('Parsing throws on incorrect messages', () => {
        let errorCount = 0
        try {
            parseWrapper<RpcMessage>(() => RpcMessage.fromBinary(Buffer.from('adda')))
        } catch (err) {
            errorCount += 1
        }
        expect(errorCount).toEqual(1)
    })

    it('Serializing successfully', () => {
        const directSerialized = RpcMessage.toBinary(msg)
        const serialized = serializeWrapper(() => RpcMessage.toBinary(msg))
        expect(Buffer.compare(directSerialized, serialized)).toEqual(0)
    })

    it('Serializing fails on incorrect messages', () => {
        let errorCount = 0
        try {
            serializeWrapper(() =>
                RpcMessage.toBinary(
                    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                    // @ts-ignore
                    { asd: "aaaaa" }
                )
            )

        } catch (err) {
            errorCount += 1
        }
        expect(errorCount).toEqual(1)
    })
})
