const { startNetworkNode } = require('../../src/composition')
const { LOCALHOST } = require('../util')

describe('NetworkNode creation', () => {
    it('should be able to start and stop successfully', async (done) => {
        await startNetworkNode(LOCALHOST, 30370).then((networkNode) => {
            expect(networkNode.protocols.nodeToNode.endpoint.getAddress()).toEqual('ws://127.0.0.1:30370')
            networkNode.stop(() => done())
        })
    })
})
