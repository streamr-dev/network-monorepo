import { NodeToTracker } from '../../protocol/NodeToTracker'
import { ReceiptStore } from './ReceiptStore'
import { Receipt } from 'streamr-client-protocol'
import { Event as NodeToTrackerEvent } from '../../protocol/NodeToTracker'
import { PeerInfo } from '../../connection/PeerInfo'

export function attachInspectResponder({ myPeerInfo, receiptStore, nodeToTracker }: {
    myPeerInfo: PeerInfo
    receiptStore: ReceiptStore
    nodeToTracker: NodeToTracker
}): void {
    nodeToTracker.on(NodeToTrackerEvent.RELAY_MESSAGE_RECEIVED, async (relayMessage, relayTrackerId) => {
        if (relayMessage.isInspectRequestMessage()) {
            const sendResponsePart = (receipt: Receipt | null) => nodeToTracker.sendInspectResponsePart(
                relayTrackerId,
                relayMessage.originator.peerId,
                myPeerInfo,
                relayMessage.requestId,
                receipt
            )
            const receipts = receiptStore.getTheirReceipts(relayMessage.data.inspectionTarget)
            for (const receipt of receipts) {
                await sendResponsePart(receipt)
            }
            await sendResponsePart(null)
        }
    })
}
