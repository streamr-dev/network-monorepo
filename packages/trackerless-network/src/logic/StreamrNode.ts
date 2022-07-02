import { DhtNode } from '@streamr/dht'
import { RandomGraphNode, Event as RandomGraphEvent } from './RandomGraphNode'
import { PeerDescriptor } from '@streamr/dht'
import { ITransport } from '@streamr/dht/dist/src'
import { DataMessage } from '../proto/NetworkRpc'
import { EventEmitter } from 'events'

interface StreamObject {
    layer1: DhtNode,
    layer2: RandomGraphNode
}

export enum Event {
    NEW_MESSAGE = 'unseen-message'
}

export interface StreamrNode {
    on(event: Event.NEW_MESSAGE, listener: (msg: DataMessage, nodeId: string) => void): this
}

export class StreamrNode extends EventEmitter {
    private readonly streams: Map<string, StreamObject>
    private layer0: DhtNode | null = null
    private started = false
    private stopped = false
    private P2PTransport: ITransport | null = null
    constructor() {
        super()
        this.streams = new Map()
    }

    async start(startedAndJoinedLayer0: DhtNode, transport: ITransport): Promise<void> {
        if (this.started || this.stopped) {
            return
        }
        this.started = true
        this.layer0 = startedAndJoinedLayer0
        this.P2PTransport = transport
    }

    destroy(): void {
        if (!this.started) {
            return
        }
        this.stopped = true
        this.layer0!.stop()
        this.streams.forEach((stream) => {
            stream.layer2.stop()
            stream.layer1.stop()
        })
        this.streams.clear()
    }

    subscribeToStream(streamPartID: string, entryPointDescriptor: PeerDescriptor): void {
        this.joinStream(streamPartID, entryPointDescriptor)
            .then(() => this.streams.get(streamPartID)?.layer2.on(
                RandomGraphEvent.MESSAGE,
                (message: DataMessage) =>
                    this.emit(Event.NEW_MESSAGE, message, message.senderId))
            )
            .catch((_err) => {
                // console.log(err)
            })
    }

    publishToStream(streamPartID: string, entryPointDescriptor: PeerDescriptor, msg: DataMessage): void {
        if (this.streams.has(streamPartID)) {
            this.streams.get(streamPartID)!.layer2.broadcast(msg)
        } else {
            this.joinStream(streamPartID, entryPointDescriptor)
                .then(() => this.streams.get(streamPartID)?.layer2.broadcast(msg))
                .catch((_err) => {
                    // console.log(err)
                })
        }
    }

    unsubscribeFromStream(streamPartID: string): void {
        this.leaveStream(streamPartID)
    }

    leaveStream(streamPartID: string): void {
        const stream = this.streams.get(streamPartID)
        if (stream) {
            stream.layer2.stop()
            stream.layer1.stop()
        }
    }

    async joinStream(streamPartID: string, entryPoint: PeerDescriptor): Promise<void> {
        if (this.streams.has(streamPartID)) {
            return
        }
        const layer1 = new DhtNode({
            transportLayer: this.layer0!,
            appId: streamPartID,
            peerDescriptor: this.layer0!.getPeerDescriptor()
        })
        const layer2 = new RandomGraphNode({
            randomGraphId: streamPartID,
            P2PTransport: this.P2PTransport!,
            layer1: layer1
        })
        this.streams.set(streamPartID, {
            layer1,
            layer2
        })
        await layer1.start()
        layer2.start()
        await layer1.joinDht(entryPoint)
    }

    getStream(streamPartID: string): StreamObject | undefined {
        return this.streams.get(streamPartID)
    }

    getPeerDescriptor(): PeerDescriptor {
        return this.layer0!.getPeerDescriptor()
    }
}
