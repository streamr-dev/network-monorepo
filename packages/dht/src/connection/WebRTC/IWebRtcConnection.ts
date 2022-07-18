export enum Event {
    LOCAL_DESCRIPTION = 'streamr:dht:webrtcconnection:localdescription',
    LOCAL_CANDIDATE = 'streamr:dht:webrtcconnection:localcandidate',
}

export enum RtcDescription {
    OFFER = 'offer',
    ANSWER = 'answer'
}

export interface IWebRtcConnection {
    start(isOffering: boolean): void

    on(event: Event.LOCAL_DESCRIPTION, listener: (description: string, type: string) => void): this
    on(event: Event.LOCAL_CANDIDATE, listener: (candidate: string, mid: string) => void): this
    once(event: Event.LOCAL_CANDIDATE, listener: (candidate: string, mid: string) => void): this
    once(event: Event.LOCAL_DESCRIPTION, listener: (description: string, type: string) => void): this

    setRemoteDescription(description: string, type: string): Promise<void>
    addRemoteCandidate(candidate: string, mid: string): void
    isOpen(): boolean
}
