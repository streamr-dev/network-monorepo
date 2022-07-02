import EventEmitter = require('events')
import { DhtNode, DhtNodeEvent, PeerID, PeerDescriptor, DhtPeer, RoutingRpcCommunicator, ITransport } from '@streamr/dht'
import { DataMessage, HandshakeRequest, HandshakeResponse, LeaveNotice, MessageRef } from '../proto/NetworkRpc'
import { NodeNeighbors } from './NodeNeighbors'
import { NetworkRpcClient } from '../proto/NetworkRpc.client'
import { RemoteRandomGraphNode } from './RemoteRandomGraphNode'
import { INetworkRpc } from '../proto/NetworkRpc.server'
import { Empty } from '../proto/google/protobuf/empty'
import { ServerCallContext } from '@protobuf-ts/runtime-rpc'
import { DuplicateMessageDetector, NumberPair } from './DuplicateMessageDetector'

export enum Event {
    MESSAGE = 'streamr:layer2:random-graph-node:onmessage'
}

export interface RandomGraphNode {
    on(event: Event.MESSAGE, listener: (message: DataMessage) => any): this
}

export interface RandomGraphNodeParams {
    randomGraphId: string,
    layer1: DhtNode,
    P2PTransport: ITransport
}

export class RandomGraphNode extends EventEmitter implements INetworkRpc {
    private stopped = false
    private started = false
    private readonly N = 4
    private readonly PEER_VIEW_SIZE = 10
    private readonly randomGraphId: string // StreamPartID
    private readonly layer1: DhtNode
    private readonly contactPool: NodeNeighbors
    private readonly selectedNeighbors: NodeNeighbors = new NodeNeighbors(4)
    private rpcCommunicator: RoutingRpcCommunicator | null = null
    private readonly P2PTransport: ITransport
    private readonly duplicateDetector: DuplicateMessageDetector
    private bootstrapIntervalRef: NodeJS.Timeout | null = null

    constructor(params: RandomGraphNodeParams) {
        super()
        this.randomGraphId = params.randomGraphId
        this.layer1 = params.layer1
        this.P2PTransport = params.P2PTransport

        this.contactPool = new NodeNeighbors(this.PEER_VIEW_SIZE)
        this.selectedNeighbors = new NodeNeighbors(this.N)
        this.duplicateDetector = new DuplicateMessageDetector(10000)
    }

    start(): void {
        this.started = true
        this.rpcCommunicator = new RoutingRpcCommunicator(`layer2-${this.randomGraphId}`, this.P2PTransport)
        this.layer1.on(DhtNodeEvent.NEW_CONTACT, (peerDescriptor, closestTen) => this.newContact(peerDescriptor, closestTen))
        this.layer1.on(DhtNodeEvent.CONTACT_REMOVED, (peerDescriptor, closestTen) => this.removedContact(peerDescriptor, closestTen))
        const candidates = this.getNewNeighborCandidates()
        if (candidates.length) {
            this.newContact(candidates[0], candidates)
        }
        this.registerDefaultServerMethods()
        this.bootstrapIntervalRef = setInterval(() => {
            if (this.selectedNeighbors.size() < this.N && this.layer1.getNeighborList().getSize() >= 1) {
                this.newContact(
                    {peerId: new Uint8Array(), type: 0},
                    this.layer1.getNeighborList().getActiveContacts(this.PEER_VIEW_SIZE).map((peer) => peer.getPeerDescriptor())
                )
            }
        },2000)
    }

    stop(): void {
        if (!this.started) {
            return
        }
        this.stopped = true
        this.selectedNeighbors.values().map((remote) => remote.leaveNotice(this.layer1.getPeerDescriptor()))
        this.rpcCommunicator!.stop()
        this.removeAllListeners()
        this.layer1.off(DhtNodeEvent.NEW_CONTACT, (peerDescriptor, closestTen) => this.newContact(peerDescriptor, closestTen))
        this.layer1.off(DhtNodeEvent.CONTACT_REMOVED, (peerDescriptor, closestTen) => this.removedContact(peerDescriptor, closestTen))
        this.contactPool.clear()
        this.selectedNeighbors.clear()
        if (this.bootstrapIntervalRef) {
            clearInterval(this.bootstrapIntervalRef)
        }
    }

    broadcast(msg: DataMessage, previousPeer?: string): void {
        if (!previousPeer) {
            this.markAndCheckDuplicate(msg.messageRef!, msg.previousMessageRef)
        }
        this.selectedNeighbors.getStringIds().map((remote) => {
            if (previousPeer !== remote) {
                this.selectedNeighbors.getNeighborWithId(remote)!.sendData(this.layer1.getPeerDescriptor(), msg)
            }
        })
    }

    private newContact(_newContact: PeerDescriptor, closestTen: PeerDescriptor[]): void {
        if (this.stopped) {
            return
        }
        const toReplace: string[] = []
        this.contactPool.replaceAll(closestTen.map((descriptor) =>
            new RemoteRandomGraphNode(descriptor, this.randomGraphId, new NetworkRpcClient(this.rpcCommunicator!.getRpcClientTransport()))))
        this.selectedNeighbors.getStringIds().forEach((neighbor) => {
            if (!this.contactPool.hasNeighborWithStringId(neighbor)) {
                toReplace.push(neighbor)
            }
        })
        this.replaceNeighbors(toReplace).catch((_err) => {})
    }

    private removedContact(removedContact: PeerDescriptor, closestTen: PeerDescriptor[]): void {
        if (this.stopped) {
            return
        }
        const toReplace: string[] = []
        if (this.selectedNeighbors.hasNeighbor(removedContact)) {
            toReplace.push(PeerID.fromValue(removedContact.peerId).toMapKey())
        }
        this.contactPool.replaceAll(closestTen.map((descriptor) =>
            new RemoteRandomGraphNode(descriptor, this.randomGraphId, new NetworkRpcClient(this.rpcCommunicator!.getRpcClientTransport()))))
        this.selectedNeighbors.getStringIds().forEach((neighbor) => {
            if (!this.contactPool.hasNeighborWithStringId(neighbor)) {
                toReplace.push(neighbor)
            }
        })
        this.replaceNeighbors(toReplace).catch((_err) => {})
    }

    private async replaceNeighbors(stringIds: string[]): Promise<void> {
        if (this.stopped) {
            return
        }
        stringIds.forEach((replace) => {
            const toReplace = this.selectedNeighbors.getNeighborWithId(replace)
            if (toReplace) {
                this.selectedNeighbors.remove(toReplace.getPeerDescriptor())
            }
        })
        const promises: Promise<void>[] = []
        // Fill up neighbors to N
        for (let i = this.selectedNeighbors.size(); i < this.N; i++) {
            if (this.selectedNeighbors.size() >= this.contactPool.size()
                || this.contactPool.size() < i) {
                break
            }
            const promise = this.addRandomContactToNeighbors()
            promises.push(promise)
        }
        await Promise.all(promises)
    }

    private getNewNeighborCandidates(): PeerDescriptor[] {
        return this.layer1.getNeighborList().getActiveContacts(this.PEER_VIEW_SIZE).map((contact: DhtPeer) => {
            return contact.getPeerDescriptor()
        })
    }

    private async addRandomContactToNeighbors(): Promise<void> {
        if (this.stopped) {
            return
        }
        const newNeighbor = this.contactPool.getRandom()
        if (newNeighbor) {
            const stringId = PeerID.fromValue(newNeighbor.getPeerDescriptor().peerId).toMapKey()
            if (!this.selectedNeighbors.hasNeighborWithStringId(stringId)) {
                // Negotiate Layer 2 connection here if success add as neighbor
                this.selectedNeighbors.add(newNeighbor)
                const accepted = await newNeighbor.handshake(this.layer1.getPeerDescriptor())
                if (!accepted) {
                    this.selectedNeighbors.remove(newNeighbor.getPeerDescriptor())
                    this.addRandomContactToNeighbors().catch(() => {})
                }
            }

        }
    }

    getSelectedNeighborIds(): string[] {
        return this.selectedNeighbors.getStringIds()
    }

    getContactPoolIds(): string[] {
        return this.contactPool.getStringIds()
    }

    private markAndCheckDuplicate(currentMessageRef: MessageRef, previousMessageRef?: MessageRef): boolean {
        const previousNumberPair = previousMessageRef ?
            new NumberPair(previousMessageRef!.timestamp, previousMessageRef!.sequenceNumber)
            : null
        const currentNumberPair = new NumberPair(currentMessageRef.timestamp, currentMessageRef.sequenceNumber)
        return this.duplicateDetector.markAndCheck(previousNumberPair, currentNumberPair)
    }

    getOwnStringId(): string {
        return PeerID.fromValue(this.layer1.getPeerDescriptor().peerId).toMapKey()
    }

    registerDefaultServerMethods(): void {
        this.rpcCommunicator!.registerRpcMethod(HandshakeRequest, HandshakeResponse, 'handshake', this.handshake)
        this.rpcCommunicator!.registerRpcNotification(DataMessage, 'sendData', this.sendData.bind(this))
        this.rpcCommunicator!.registerRpcNotification(LeaveNotice, 'leaveNotice', this.leaveNotice.bind(this))
    }

    // INetworkRpc server method
    async handshake(request: HandshakeRequest, _context: ServerCallContext): Promise<HandshakeResponse> {
        // Add checking for connection handshakes
        const res: HandshakeResponse = {
            requestId: request.requestId,
            accepted: true
        }
        return res
    }

    // INetworkRpc server method
    async sendData(message: DataMessage, _context: ServerCallContext): Promise<Empty> {
        if (this.markAndCheckDuplicate(message.messageRef!, message.previousMessageRef)) {
            const { previousPeer } = message
            message["previousPeer"] = PeerID.fromValue(this.layer1.getPeerDescriptor().peerId).toMapKey()
            this.emit(Event.MESSAGE, message)
            this.broadcast(message, previousPeer)
        }
        return Empty
    }

    // INetworkRpc server method
    async leaveNotice(message: LeaveNotice, _context: ServerCallContext): Promise<Empty> {
        if (message.randomGraphId === this.randomGraphId) {
            const contact = this.contactPool.getNeighborWithId(message.senderId)
            // TODO: check integrity of notifier?
            if (contact) {
                this.layer1!.removeContact(contact.getPeerDescriptor(), true)
                this.selectedNeighbors.remove(contact.getPeerDescriptor())
                this.contactPool.remove(contact.getPeerDescriptor())
            }
        }
        return Empty
    }
}
