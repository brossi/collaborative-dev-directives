import Foundation
import Testing
@testable import CannaBeatsHostCore

private final class PermissionTestMemory: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: AudioCaptureReadiness?
    private var probes = 0
    private var saves = 0

    func load() -> AudioCaptureReadiness? { lock.withLock { stored } }
    func save(_ result: AudioCaptureReadiness) {
        lock.withLock {
            stored = result
            saves += 1
        }
    }
    func probe() { lock.withLock { probes += 1 } }
    func snapshot() -> (result: AudioCaptureReadiness?, probes: Int, saves: Int) {
        lock.withLock { (stored, probes, saves) }
    }
}

private final class PermissionTestGate: @unchecked Sendable {
    private let started = DispatchSemaphore(value: 0)
    private let release = DispatchSemaphore(value: 0)
    func markStarted() { started.signal() }
    func waitUntilStarted() -> Bool { started.wait(timeout: .now() + 1) == .success }
    func waitForRelease() { release.wait() }
    func finish() { release.signal() }
}

@Test func permissionProbeCoalescesConcurrentRequestsAndRetainsSuccess() async {
    let memory = PermissionTestMemory()
    let gate = PermissionTestGate()
    let permission = SystemAudioCapturePermission(
        supported: { true }, loadResult: { memory.load() },
        saveResult: { memory.save($0) }, probe: {
            memory.probe()
            gate.markStarted()
            gate.waitForRelease()
        }
    )

    let first = Task {
        let result = await permission.requestReadiness()
        return (result, permission.readiness())
    }
    #expect(gate.waitUntilStarted())
    let duplicate = Task {
        let result = await permission.requestReadiness()
        return (result, permission.readiness())
    }
    await Task.yield()
    gate.finish()

    let firstResult = await first.value
    let duplicateResult = await duplicate.value
    #expect(firstResult.0 == .ready && firstResult.1 == .ready)
    #expect(duplicateResult.0 == .ready && duplicateResult.1 == .ready)
    let snapshot = memory.snapshot()
    #expect(snapshot.result == .ready)
    #expect(snapshot.probes == 1)
    #expect(snapshot.saves == 1)
}

@Test func permissionProbeNormalizesFailureAndDoesNotRetainNativeError() async {
    let memory = PermissionTestMemory()
    let permission = SystemAudioCapturePermission(
        supported: { true }, loadResult: { memory.load() },
        saveResult: { memory.save($0) },
        probe: { throw CocoaError(.fileReadNoPermission) }
    )

    #expect(await permission.requestReadiness() == .failed)
    #expect(memory.snapshot().result == .failed)
}

@Test func unsupportedSystemDoesNotRunPermissionProbe() async {
    let memory = PermissionTestMemory()
    let permission = SystemAudioCapturePermission(
        supported: { false }, loadResult: { .ready }, saveResult: { memory.save($0) },
        probe: { memory.probe() }
    )

    #expect(await permission.requestReadiness() == .unsupported)
    #expect(memory.snapshot().probes == 0)
}
