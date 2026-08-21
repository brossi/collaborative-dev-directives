import Foundation
import Network

public let sharedAudioPacketLimit = 64
public let sharedAudioPacketByteLimit = 4_096 * 2 * MemoryLayout<Int16>.size

public enum SharedAudioFailure: Error, Equatable, Sendable {
    case invalidConfiguration
    case invalidFormat
    case invalidResponse
    case unavailable
    case interrupted
}

public struct SharedAudioStreamIdentity: Equatable, Sendable {
    public let gameID: UUID
    public let audioSessionID: UUID
    public let generation: Int

    public init(gameID: UUID, audioSessionID: UUID, generation: Int) {
        self.gameID = gameID
        self.audioSessionID = audioSessionID
        self.generation = generation
    }
}

public final class BoundedPCMUploadBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var packets: [Data] = []
    public let capacity: Int
    private var retainedDroppedPackets: UInt64 = 0
    private var retainedDroppedFrames: UInt64 = 0

    public var droppedPackets: UInt64 { lock.withLock { retainedDroppedPackets } }
    public var droppedFrames: UInt64 { lock.withLock { retainedDroppedFrames } }

    public init(capacity: Int = sharedAudioPacketLimit) {
        precondition(capacity > 0 && capacity <= sharedAudioPacketLimit)
        self.capacity = capacity
        packets.reserveCapacity(capacity)
    }

    @discardableResult
    public func enqueue(_ packet: Data) -> Bool {
        guard !packet.isEmpty, packet.count <= sharedAudioPacketByteLimit,
              packet.count.isMultiple(of: 4) else { return false }
        lock.lock()
        defer { lock.unlock() }
        if packets.count == capacity {
            let removed = packets.removeFirst()
            retainedDroppedPackets += 1
            retainedDroppedFrames += UInt64(removed.count / 4)
        }
        packets.append(packet)
        return true
    }

    public func dequeue() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return packets.isEmpty ? nil : packets.removeFirst()
    }

    public func removeAll() {
        lock.lock()
        packets.removeAll(keepingCapacity: true)
        lock.unlock()
    }

    public var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return packets.count
    }
}

public struct SharedAudioResponseHead: Equatable, Sendable {
    public let sessionID: UUID
    public let generation: Int
    public let sampleRate: Int

    public static func parse(
        _ data: Data, expectedSessionID: UUID, expectedGeneration: Int
    ) throws -> (head: SharedAudioResponseHead, bodyRemainder: Data) {
        guard data.count <= 8_192,
              let marker = data.range(of: Data([13, 10, 13, 10])),
              let text = String(data: data[..<marker.lowerBound], encoding: .utf8) else {
            throw SharedAudioFailure.invalidResponse
        }
        let lines = text.components(separatedBy: "\r\n")
        guard lines.first == "HTTP/1.1 200 OK" || lines.first == "HTTP/1.1 200",
              lines.count > 1 else { throw SharedAudioFailure.invalidResponse }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else { throw SharedAudioFailure.invalidResponse }
            let name = parts[0].lowercased()
            let value = parts[1].trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, headers[name] == nil else {
                throw SharedAudioFailure.invalidResponse
            }
            headers[name] = value
        }
        let expectedSession = expectedSessionID.uuidString.lowercased()
        guard headers["content-type"] == "application/octet-stream",
              headers[AudioSessionClient.contractHeader] == AudioSessionClient.contractVersion,
              headers["x-cannabeats-audio-session"] == expectedSession,
              headers["x-cannabeats-audio-generation"] == String(expectedGeneration),
              let rateText = headers["x-cannabeats-audio-rate"],
              ["44100", "48000"].contains(rateText),
              headers["x-cannabeats-audio-channels"] == "2",
              headers["x-cannabeats-audio-encoding"] == "s16le",
              headers["transfer-encoding"]?.lowercased() == "chunked",
              headers["content-length"] == nil else {
            throw SharedAudioFailure.invalidResponse
        }
        return (
            SharedAudioResponseHead(
                sessionID: expectedSessionID,
                generation: expectedGeneration,
                sampleRate: Int(rateText)!
            ),
            Data(data[marker.upperBound...])
        )
    }
}

public final class BoundedHTTPChunkDecoder: @unchecked Sendable {
    private var buffered = Data()
    private var expectedSize: Int?
    public private(set) var isTerminal = false

    public init() {}

    public func append(_ data: Data) throws -> [Data] {
        guard !isTerminal || data.isEmpty else { throw SharedAudioFailure.invalidResponse }
        guard buffered.count + data.count <= 128 * 1_024 else {
            throw SharedAudioFailure.invalidResponse
        }
        buffered.append(data)
        var output: [Data] = []
        while !isTerminal {
            if expectedSize == nil {
                guard let lineEnd = buffered.range(of: Data([13, 10])) else {
                    if buffered.count > 16 { throw SharedAudioFailure.invalidResponse }
                    break
                }
                let line = String(decoding: buffered[..<lineEnd.lowerBound], as: UTF8.self)
                guard !line.isEmpty, line.count <= 16,
                      line.allSatisfy({ $0.isHexDigit }),
                      let size = Int(line, radix: 16), size <= 64 * 1_024 else {
                    throw SharedAudioFailure.invalidResponse
                }
                buffered.removeSubrange(..<lineEnd.upperBound)
                if size == 0 {
                    guard buffered.count >= 2 else {
                        expectedSize = 0
                        break
                    }
                    guard buffered.prefix(2) == Data([13, 10]), buffered.count == 2 else {
                        throw SharedAudioFailure.invalidResponse
                    }
                    buffered.removeAll(keepingCapacity: true)
                    expectedSize = nil
                    isTerminal = true
                    break
                }
                expectedSize = size
            }
            if expectedSize == 0 {
                guard buffered.count >= 2 else { break }
                guard buffered.prefix(2) == Data([13, 10]), buffered.count == 2 else {
                    throw SharedAudioFailure.invalidResponse
                }
                buffered.removeAll(keepingCapacity: true)
                expectedSize = nil
                isTerminal = true
                break
            }
            guard let size = expectedSize, buffered.count >= size + 2 else { break }
            guard buffered[size] == 13, buffered[size + 1] == 10 else {
                throw SharedAudioFailure.invalidResponse
            }
            output.append(Data(buffered.prefix(size)))
            buffered.removeSubrange(..<(size + 2))
            expectedSize = nil
        }
        return output
    }
}

private struct SharedAudioEndpoint {
    let host: NWEndpoint.Host
    let port: NWEndpoint.Port
    let hostHeader: String

    init(origin: URL) throws {
        guard origin.scheme == "https", let hostText = origin.host,
              origin.path.isEmpty, origin.query == nil, origin.fragment == nil,
              origin.user == nil, origin.password == nil,
              let port = NWEndpoint.Port(rawValue: UInt16(origin.port ?? 443)) else {
            throw SharedAudioFailure.invalidConfiguration
        }
        host = NWEndpoint.Host(hostText)
        self.port = port
        hostHeader = origin.port.map { "\(hostText):\($0)" } ?? hostText
    }

    var parameters: NWParameters {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_add_tls_application_protocol(
            tls.securityProtocolOptions, "http/1.1"
        )
        return NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
    }
}

private func validBearer(_ value: String) -> Bool {
    value.range(of: #"^[A-Za-z0-9_-]{22,128}$"#, options: .regularExpression) != nil
}

private func wire(_ identifier: UUID) -> String { identifier.uuidString.lowercased() }

public enum AudioIngestEvent: Equatable, Sendable {
    case connecting
    case active
    case interrupted(SharedAudioFailure)
}

public final class AuthenticatedAudioIngest: @unchecked Sendable {
    private let queue = DispatchQueue(label: "social.cannabeats.host.audio-ingest")
    private let buffer = BoundedPCMUploadBuffer()
    private let origin: URL
    private let identity: SharedAudioStreamIdentity
    private let connectionID: UUID
    private let applicationSession: String
    private let sampleRate: Int
    private var connection: NWConnection?
    private var report: (@Sendable (AudioIngestEvent) -> Void)?
    private var headerSent = false
    private var responseValidated = false
    private var responseHeader = Data()
    private var sending = false
    private var stopping = false
    private var terminalSent = false
    private var finished = false

    public init(
        origin: URL = HostAuthorityProtocol.productionOrigin,
        identity: SharedAudioStreamIdentity,
        connectionID: UUID = UUID(),
        applicationSession: String,
        sampleRate: Int
    ) throws {
        guard identity.generation > 0, validBearer(applicationSession),
              [44_100, 48_000].contains(sampleRate) else {
            throw SharedAudioFailure.invalidConfiguration
        }
        _ = try SharedAudioEndpoint(origin: origin)
        self.origin = origin
        self.identity = identity
        self.connectionID = connectionID
        self.applicationSession = applicationSession
        self.sampleRate = sampleRate
    }

    public var droppedPackets: UInt64 { buffer.droppedPackets }
    public var droppedFrames: UInt64 { buffer.droppedFrames }
    public var queuedPackets: Int { buffer.count }

    public func start(report: @escaping @Sendable (AudioIngestEvent) -> Void) {
        queue.async { [weak self] in self?.startOnQueue(report: report) }
    }

    @discardableResult
    public func enqueue(_ packet: Data) -> Bool {
        guard buffer.enqueue(packet) else { return false }
        queue.async { [weak self] in self?.pump() }
        return true
    }

    public func stop() {
        queue.async { [weak self] in
            guard let self, !self.stopping else { return }
            self.stopping = true
            self.buffer.removeAll()
            self.pump()
        }
    }

    private func startOnQueue(report: @escaping @Sendable (AudioIngestEvent) -> Void) {
        guard connection == nil, !finished else { return }
        self.report = report
        report(.connecting)
        guard let endpoint = try? SharedAudioEndpoint(origin: origin) else {
            fail(.invalidConfiguration)
            return
        }
        let connection = NWConnection(
            host: endpoint.host, port: endpoint.port, using: endpoint.parameters
        )
        self.connection = connection
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            self.queue.async {
                switch state {
                case .ready: self.sendHeader(endpoint: endpoint)
                case .failed: self.fail(.unavailable)
                case .cancelled where !self.stopping: self.fail(.interrupted)
                default: break
                }
            }
        }
        connection.start(queue: queue)
        receiveResponse(connection)
    }

    private func sendHeader(endpoint: SharedAudioEndpoint) {
        guard let connection, !headerSent else { return }
        let path = "/api/games/\(wire(identity.gameID))/audio/sessions/\(wire(identity.audioSessionID))/ingest"
        let header = """
        POST \(path) HTTP/1.1\r
        Host: \(endpoint.hostHeader)\r
        Authorization: Bearer \(applicationSession)\r
        Content-Type: application/octet-stream\r
        Transfer-Encoding: chunked\r
        \(AudioSessionClient.contractHeader): \(AudioSessionClient.contractVersion)\r
        X-CannaBeats-Audio-Connection: \(wire(connectionID))\r
        X-CannaBeats-Audio-Rate: \(sampleRate)\r
        X-CannaBeats-Audio-Channels: 2\r
        X-CannaBeats-Audio-Encoding: s16le\r
        Connection: close\r
        \r

        """
        connection.send(content: Data(header.utf8), completion: .contentProcessed {
            [weak self] error in
            guard let self else { return }
            self.queue.async {
                if error != nil { self.fail(.unavailable); return }
                self.headerSent = true
                self.pump()
            }
        })
    }

    private func pump() {
        guard headerSent, !sending, !terminalSent, let connection, !finished else { return }
        if !stopping, let packet = buffer.dequeue() {
            var chunk = Data(String(packet.count, radix: 16).utf8)
            chunk.append(contentsOf: [13, 10])
            chunk.append(packet)
            chunk.append(contentsOf: [13, 10])
            sending = true
            connection.send(content: chunk, completion: .contentProcessed { [weak self] error in
                guard let self else { return }
                self.queue.async {
                    self.sending = false
                    if error != nil { self.fail(.unavailable) } else { self.pump() }
                }
            })
            return
        }
        guard stopping else { return }
        terminalSent = true
        connection.send(
            content: Data("0\r\n\r\n".utf8), contentContext: .finalMessage,
            isComplete: true, completion: .contentProcessed { [weak self] _ in
                guard let self else { return }
                self.queue.asyncAfter(deadline: .now() + 1) { [weak self] in
                    self?.finishWithoutReport()
                }
            }
        )
    }

    private func receiveResponse(_ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8_192) {
            [weak self] data, _, complete, error in
            guard let self else { return }
            self.queue.async {
                guard !self.finished else { return }
                if let data, !data.isEmpty, !self.responseValidated {
                    self.responseHeader.append(data)
                    guard self.responseHeader.count <= 8_192 else {
                        self.fail(.invalidResponse); return
                    }
                    if self.responseHeader.range(of: Data([13, 10, 13, 10])) != nil {
                        do {
                            let parsed = try SharedAudioResponseHead.parse(
                                self.responseHeader,
                                expectedSessionID: self.identity.audioSessionID,
                                expectedGeneration: self.identity.generation
                            )
                            guard parsed.head.sampleRate == self.sampleRate,
                                  parsed.bodyRemainder.isEmpty else {
                                throw SharedAudioFailure.invalidResponse
                            }
                            self.responseValidated = true
                            self.responseHeader.removeAll(keepingCapacity: false)
                            self.report?(.active)
                        } catch { self.fail(.invalidResponse); return }
                    }
                } else if let data, !data.isEmpty, self.responseValidated, !self.stopping {
                    self.fail(.invalidResponse)
                    return
                }
                if error != nil { self.fail(self.stopping ? .interrupted : .unavailable); return }
                if complete {
                    if self.stopping { self.finishWithoutReport() } else { self.fail(.interrupted) }
                } else {
                    self.receiveResponse(connection)
                }
            }
        }
    }

    private func fail(_ reason: SharedAudioFailure) {
        guard !finished else { return }
        finished = true
        buffer.removeAll()
        connection?.cancel()
        connection = nil
        report?(.interrupted(reason))
        report = nil
    }

    private func finishWithoutReport() {
        guard !finished else { return }
        finished = true
        connection?.cancel()
        connection = nil
        report = nil
    }
}

public enum AudioListenerEvent: Equatable, Sendable {
    case connecting
    case active(sampleRate: Int)
    case interrupted(SharedAudioFailure)
}

public final class AuthenticatedAudioListener: @unchecked Sendable {
    private let queue = DispatchQueue(label: "social.cannabeats.host.audio-listener")
    private let origin: URL
    private let identity: SharedAudioStreamIdentity
    private let applicationSession: String
    private var connection: NWConnection?
    private var report: (@Sendable (AudioListenerEvent) -> Void)?
    private var consume: (@Sendable (Data) -> Void)?
    private var responseHeader = Data()
    private var decoder = BoundedHTTPChunkDecoder()
    private var pcmCarry = Data()
    private var headersParsed = false
    private var stopped = false
    private var finished = false

    public init(
        origin: URL = HostAuthorityProtocol.productionOrigin,
        identity: SharedAudioStreamIdentity,
        applicationSession: String
    ) throws {
        guard identity.generation > 0, validBearer(applicationSession) else {
            throw SharedAudioFailure.invalidConfiguration
        }
        _ = try SharedAudioEndpoint(origin: origin)
        self.origin = origin
        self.identity = identity
        self.applicationSession = applicationSession
    }

    public func start(
        report: @escaping @Sendable (AudioListenerEvent) -> Void,
        consume: @escaping @Sendable (Data) -> Void
    ) {
        queue.async { [weak self] in self?.startOnQueue(report: report, consume: consume) }
    }

    public func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            self.stopped = true
            self.finished = true
            self.connection?.cancel()
            self.connection = nil
            self.report = nil
            self.consume = nil
            self.pcmCarry.removeAll()
        }
    }

    private func startOnQueue(
        report: @escaping @Sendable (AudioListenerEvent) -> Void,
        consume: @escaping @Sendable (Data) -> Void
    ) {
        guard connection == nil, !finished else { return }
        self.report = report
        self.consume = consume
        report(.connecting)
        guard let endpoint = try? SharedAudioEndpoint(origin: origin) else {
            fail(.invalidConfiguration); return
        }
        let connection = NWConnection(
            host: endpoint.host, port: endpoint.port, using: endpoint.parameters
        )
        self.connection = connection
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            self.queue.async {
                switch state {
                case .ready: self.sendRequest(connection, endpoint: endpoint)
                case .failed: self.fail(.unavailable)
                case .cancelled where !self.stopped: self.fail(.interrupted)
                default: break
                }
            }
        }
        connection.start(queue: queue)
    }

    private func sendRequest(_ connection: NWConnection, endpoint: SharedAudioEndpoint) {
        let path = "/api/games/\(wire(identity.gameID))/audio/sessions/\(wire(identity.audioSessionID))/listen"
        let request = """
        GET \(path) HTTP/1.1\r
        Host: \(endpoint.hostHeader)\r
        Authorization: Bearer \(applicationSession)\r
        \(AudioSessionClient.contractHeader): \(AudioSessionClient.contractVersion)\r
        Connection: close\r
        \r

        """
        connection.send(content: Data(request.utf8), completion: .contentProcessed {
            [weak self] error in
            guard let self else { return }
            self.queue.async {
                if error != nil { self.fail(.unavailable) } else { self.receive(connection) }
            }
        })
    }

    private func receive(_ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 32 * 1_024) {
            [weak self] data, _, complete, error in
            guard let self else { return }
            self.queue.async {
                guard !self.finished else { return }
                if let data, !data.isEmpty {
                    do { try self.consumeNetworkData(data) }
                    catch { self.fail(.invalidResponse); return }
                }
                if error != nil { self.fail(self.stopped ? .interrupted : .unavailable); return }
                if complete {
                    self.fail(.interrupted)
                } else {
                    self.receive(connection)
                }
            }
        }
    }

    private func consumeNetworkData(_ data: Data) throws {
        var body = data
        if !headersParsed {
            responseHeader.append(data)
            guard responseHeader.count <= 8_192 else { throw SharedAudioFailure.invalidResponse }
            guard responseHeader.range(of: Data([13, 10, 13, 10])) != nil else { return }
            let parsed = try SharedAudioResponseHead.parse(
                responseHeader, expectedSessionID: identity.audioSessionID,
                expectedGeneration: identity.generation
            )
            headersParsed = true
            responseHeader.removeAll(keepingCapacity: false)
            body = parsed.bodyRemainder
            report?(.active(sampleRate: parsed.head.sampleRate))
        }
        for chunk in try decoder.append(body) {
            let combined = pcmCarry.isEmpty ? chunk : pcmCarry + chunk
            let complete = combined.count - combined.count % 4
            if complete > 0 { consume?(Data(combined.prefix(complete))) }
            pcmCarry = complete == combined.count ? Data() : Data(combined.suffix(from: complete))
        }
        if decoder.isTerminal {
            guard pcmCarry.isEmpty else { throw SharedAudioFailure.invalidResponse }
            throw SharedAudioFailure.interrupted
        }
    }

    private func fail(_ reason: SharedAudioFailure) {
        guard !finished else { return }
        finished = true
        connection?.cancel()
        connection = nil
        report?(.interrupted(reason))
        report = nil
        consume = nil
        pcmCarry.removeAll()
    }
}
