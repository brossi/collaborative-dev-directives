import AVFoundation
import AudioTapBridge
import Foundation
import Network

struct RelayGrant: Decodable {
    let origin: URL
    let ingestToken: String
    let listenToken: String
    let mode: String
}

enum RelayAudioError: LocalizedError {
    case invalidRelayURL
    case audioPlayerFormat
    case relayResponse(String)

    var errorDescription: String? {
        switch self {
        case .invalidRelayURL:
            "The CannaBeats server returned an invalid relay address."
        case .audioPlayerFormat:
            "The Mac could not create the relay playback format."
        case .relayResponse(let message):
            message
        }
    }
}

private struct RelayEndpoint {
    let host: NWEndpoint.Host
    let port: NWEndpoint.Port
    let hostHeader: String

    init(origin: URL) throws {
        guard origin.scheme?.lowercased() == "https", let hostText = origin.host else {
            throw RelayAudioError.invalidRelayURL
        }
        let portValue = UInt16(origin.port ?? 443)
        guard let port = NWEndpoint.Port(rawValue: portValue) else {
            throw RelayAudioError.invalidRelayURL
        }
        host = NWEndpoint.Host(hostText)
        self.port = port
        hostHeader = origin.port.map { "\(hostText):\($0)" } ?? hostText
    }
}

private final class RelayIngestClient: @unchecked Sendable {
    private let queue = DispatchQueue(label: "social.cannabeats.host.relay-ingest")
    private var connection: NWConnection?
    private var pending: [Data] = []
    private var headerSent = false
    private var sending = false
    private var stopping = false
    private var terminalSent = false
    private var stateHandler: (@Sendable (String) -> Void)?
    private var droppedPacketCount: UInt64 = 0

    var droppedPackets: UInt64 { queue.sync { droppedPacketCount } }

    func start(
        origin: URL,
        token: String,
        sampleRate: Int,
        channels: Int,
        stateHandler: @escaping @Sendable (String) -> Void
    ) throws {
        let endpoint = try RelayEndpoint(origin: origin)
        self.stateHandler = stateHandler
        let connection = NWConnection(host: endpoint.host, port: endpoint.port, using: .tls)
        self.connection = connection
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.sendRequestHeader(
                    host: endpoint.hostHeader,
                    token: token,
                    sampleRate: sampleRate,
                    channels: channels
                )
            case .failed(let error):
                self.stateHandler?("Relay upload failed: \(error.localizedDescription)")
            case .cancelled:
                break
            default:
                break
            }
        }
        connection.start(queue: queue)
        receiveResponse(on: connection)
    }

    func enqueue(_ pcm: Data) {
        guard !pcm.isEmpty else { return }
        queue.async { [weak self] in
            guard let self, !self.stopping else { return }
            if self.pending.count >= 96 {
                self.pending.removeFirst()
                self.droppedPacketCount += 1
            }
            self.pending.append(pcm)
            self.pump()
        }
    }

    func stop() {
        queue.async {
            self.stopping = true
            self.pump()
        }
    }

    private func sendRequestHeader(host: String, token: String, sampleRate: Int, channels: Int) {
        guard let connection else { return }
        let header = """
        POST /ingest HTTP/1.1\r
        Host: \(host)\r
        Authorization: Bearer \(token)\r
        Content-Type: application/octet-stream\r
        Transfer-Encoding: chunked\r
        X-Audio-Rate: \(sampleRate)\r
        X-Audio-Channels: \(channels)\r
        X-Audio-Encoding: s16le\r
        User-Agent: CannaBeats-Host-PoC/0.2\r
        Connection: close\r
        \r

        """
        connection.send(content: Data(header.utf8), completion: .contentProcessed { [weak self] error in
            guard let self else { return }
            if let error {
                self.stateHandler?("Relay upload header failed: \(error.localizedDescription)")
                return
            }
            self.headerSent = true
            self.stateHandler?("Relay upload connected; forwarding captured audio.")
            self.pump()
        })
    }

    private func pump() {
        guard headerSent, !sending, !terminalSent, let connection else { return }
        if !pending.isEmpty {
            let pcm = pending.removeFirst()
            var chunk = Data(String(pcm.count, radix: 16).utf8)
            chunk.append(contentsOf: [13, 10])
            chunk.append(pcm)
            chunk.append(contentsOf: [13, 10])
            sending = true
            connection.send(content: chunk, completion: .contentProcessed { [weak self] error in
                guard let self else { return }
                self.sending = false
                if let error {
                    self.stateHandler?("Relay audio upload failed: \(error.localizedDescription)")
                    return
                }
                self.pump()
            })
            return
        }
        guard stopping else { return }
        terminalSent = true
        connection.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { [weak self] _ in
            guard let self else { return }
            self.queue.asyncAfter(deadline: .now() + 2) {
                self.connection?.cancel()
                self.connection = nil
            }
        })
    }

    private func receiveResponse(on connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8_192) { [weak self] data, _, complete, error in
            guard let self else { return }
            if let data, !data.isEmpty, let text = String(data: data.prefix(512), encoding: .utf8),
               let statusLine = text.components(separatedBy: "\r\n").first,
               !statusLine.contains(" 200 ") {
                self.stateHandler?("The relay rejected audio upload (\(statusLine)).")
            }
            if let error {
                if !self.stopping {
                    self.stateHandler?("Relay upload response failed: \(error.localizedDescription)")
                }
                return
            }
            if !complete { self.receiveResponse(on: connection) }
        }
    }
}

private final class PCMRelayPlayer: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private var format: AVAudioFormat?

    func start(sampleRate: Double, channels: AVAudioChannelCount) throws {
        stop()
        guard let format = AVAudioFormat(
            standardFormatWithSampleRate: sampleRate,
            channels: channels
        ) else { throw RelayAudioError.audioPlayerFormat }
        self.format = format
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        try engine.start()
        node.play()
    }

    func append(interleavedInt16 data: Data, channels: Int) {
        guard let format, channels > 0 else { return }
        let frameCount = data.count / (channels * MemoryLayout<Int16>.size)
        guard frameCount > 0,
              let buffer = AVAudioPCMBuffer(
                  pcmFormat: format,
                  frameCapacity: AVAudioFrameCount(frameCount)
              ),
              let destination = buffer.floatChannelData else { return }
        buffer.frameLength = AVAudioFrameCount(frameCount)
        data.withUnsafeBytes { bytes in
            let samples = bytes.bindMemory(to: Int16.self)
            for frame in 0..<frameCount {
                for channel in 0..<channels {
                    destination[channel][frame] = Float(samples[frame * channels + channel]) / 32_768.0
                }
            }
        }
        node.scheduleBuffer(buffer)
    }

    func stop() {
        if node.engine != nil {
            node.stop()
            engine.stop()
            engine.disconnectNodeOutput(node)
            engine.detach(node)
        }
        format = nil
    }
}

private final class HTTPChunkDecoder {
    private var buffered = Data()
    private var expectedSize: Int?

    func append(_ data: Data, body: (Data) -> Void) {
        buffered.append(data)
        while true {
            if expectedSize == nil {
                guard let lineEnd = buffered.range(of: Data([13, 10])) else { return }
                let lineData = buffered[..<lineEnd.lowerBound]
                let sizeText = String(decoding: lineData, as: UTF8.self)
                    .split(separator: ";", maxSplits: 1).first.map(String.init) ?? ""
                guard let size = Int(sizeText.trimmingCharacters(in: .whitespaces), radix: 16) else {
                    buffered.removeAll()
                    return
                }
                buffered.removeSubrange(..<lineEnd.upperBound)
                if size == 0 {
                    buffered.removeAll()
                    return
                }
                expectedSize = size
            }
            guard let size = expectedSize, buffered.count >= size + 2 else { return }
            body(Data(buffered.prefix(size)))
            buffered.removeFirst(size + 2)
            expectedSize = nil
        }
    }
}

private final class RelayListenerClient: @unchecked Sendable {
    private let queue = DispatchQueue(label: "social.cannabeats.host.relay-listener")
    private let player = PCMRelayPlayer()
    private var connection: NWConnection?
    private var stopped = false
    private var headerBuffer = Data()
    private var headersParsed = false
    private var chunked = false
    private var channels = 2
    private var decoder = HTTPChunkDecoder()
    private var stateHandler: (@Sendable (String) -> Void)?
    private var origin: URL?
    private var token = ""

    func start(
        origin: URL,
        token: String,
        stateHandler: @escaping @Sendable (String) -> Void
    ) throws {
        _ = try RelayEndpoint(origin: origin)
        self.origin = origin
        self.token = token
        self.stateHandler = stateHandler
        stopped = false
        connect()
    }

    func stop() {
        queue.async {
            self.stopped = true
            self.connection?.cancel()
            self.connection = nil
            self.player.stop()
        }
    }

    private func connect() {
        guard !stopped, let origin, let endpoint = try? RelayEndpoint(origin: origin) else { return }
        headersParsed = false
        headerBuffer.removeAll(keepingCapacity: true)
        decoder = HTTPChunkDecoder()
        let connection = NWConnection(host: endpoint.host, port: endpoint.port, using: .tls)
        self.connection = connection
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                let request = """
                GET /stream.pcm HTTP/1.1\r
                Host: \(endpoint.hostHeader)\r
                Authorization: Bearer \(self.token)\r
                User-Agent: CannaBeats-Host-PoC/0.2\r
                Connection: close\r
                \r

                """
                connection.send(content: Data(request.utf8), completion: .contentProcessed { _ in })
                self.receive(on: connection)
            case .failed(let error):
                self.retry("Relay listener failed: \(error.localizedDescription)")
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func receive(on connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 32_768) { [weak self] data, _, complete, error in
            guard let self, !self.stopped else { return }
            if let data, !data.isEmpty { self.consume(data, connection: connection) }
            if let error {
                self.retry("Relay listener ended: \(error.localizedDescription)")
                return
            }
            if complete {
                self.retry("Relay listener ended; reconnecting.")
            } else {
                self.receive(on: connection)
            }
        }
    }

    private func consume(_ data: Data, connection: NWConnection) {
        if !headersParsed {
            headerBuffer.append(data)
            guard let marker = headerBuffer.range(of: Data([13, 10, 13, 10])) else { return }
            let headerData = headerBuffer[..<marker.lowerBound]
            let remainder = Data(headerBuffer[marker.upperBound...])
            let headerText = String(decoding: headerData, as: UTF8.self)
            let lines = headerText.components(separatedBy: "\r\n")
            let statusLine = lines.first ?? "Invalid relay response"
            guard statusLine.contains(" 200 ") else {
                connection.cancel()
                retry("Waiting for the relay source (\(statusLine)).")
                return
            }
            var headers: [String: String] = [:]
            for line in lines.dropFirst() {
                let pieces = line.split(separator: ":", maxSplits: 1)
                if pieces.count == 2 {
                    headers[String(pieces[0]).lowercased()] = pieces[1].trimmingCharacters(in: .whitespaces)
                }
            }
            let rate = Double(headers["x-audio-rate"] ?? "") ?? 48_000
            channels = Int(headers["x-audio-channels"] ?? "") ?? 2
            guard (1...2).contains(channels) else {
                stateHandler?("The relay returned an unsupported channel count.")
                connection.cancel()
                return
            }
            do {
                try player.start(sampleRate: rate, channels: AVAudioChannelCount(channels))
            } catch {
                stateHandler?(error.localizedDescription)
                connection.cancel()
                return
            }
            chunked = headers["transfer-encoding"]?.lowercased().contains("chunked") == true
            headersParsed = true
            headerBuffer.removeAll()
            stateHandler?("Host is listening through the same relay stream as players.")
            if !remainder.isEmpty { consumeBody(remainder) }
            return
        }
        consumeBody(data)
    }

    private func consumeBody(_ data: Data) {
        if chunked {
            decoder.append(data) { [weak self] pcm in
                guard let self else { return }
                self.player.append(interleavedInt16: pcm, channels: self.channels)
            }
        } else {
            player.append(interleavedInt16: data, channels: channels)
        }
    }

    private func retry(_ message: String) {
        guard !stopped else { return }
        stateHandler?(message)
        connection?.cancel()
        connection = nil
        player.stop()
        queue.asyncAfter(deadline: .now() + 1) { [weak self] in self?.connect() }
    }
}

final class RelayAudioSession: @unchecked Sendable {
    private let tap = CBAudioTap()
    private let ingest = RelayIngestClient()
    private let listener = RelayListenerClient()

    var sampleRate: Double { tap.sampleRate }
    var capturedFrames: UInt64 { tap.capturedFrames }
    var peakLevel: Float { tap.peakLevel }
    var droppedUploadPackets: UInt64 { ingest.droppedPackets }

    func start(
        processObjectID: UInt32,
        grant: RelayGrant,
        stateHandler: @escaping @Sendable (String) -> Void
    ) throws {
        try tap.startProcessObject(processObjectID, packetHandler: { [weak ingest] data in
            ingest?.enqueue(data)
        })
        do {
            try ingest.start(
                origin: grant.origin,
                token: grant.ingestToken,
                sampleRate: Int(tap.sampleRate.rounded()),
                channels: Int(tap.channelCount),
                stateHandler: stateHandler
            )
            try listener.start(
                origin: grant.origin,
                token: grant.listenToken,
                stateHandler: stateHandler
            )
        } catch {
            tap.stop()
            ingest.stop()
            listener.stop()
            throw error
        }
    }

    func stop() {
        tap.stop()
        ingest.stop()
        listener.stop()
    }

    deinit {
        stop()
    }
}
