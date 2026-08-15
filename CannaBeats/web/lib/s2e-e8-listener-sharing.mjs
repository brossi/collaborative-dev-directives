const ACTIVE = new Set(['enabling','enabled','stopping']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class E8ListenerSharingError extends Error {
  constructor(code) {
    super(code);
    this.name = 'E8ListenerSharingError';
    this.code = code;
  }
}

function fail(code = 'sharing_invalid') {
  throw new E8ListenerSharingError(code);
}

function summaries(lifecycle) {
  if (!lifecycle || typeof lifecycle.instanceId !== 'string'
    || !Array.isArray(lifecycle.windows) || !Array.isArray(lifecycle.transitions)) fail();
  return [...lifecycle.windows,...lifecycle.transitions]
    .sort((left,right) => left.sequence - right.sequence);
}

function finiteResult(value,statuses) {
  if (!value || typeof value !== 'object' || !statuses.includes(value.status)) {
    fail('sharing_response_invalid');
  }
  return value;
}

function exactResult(value,keys) {
  if (Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value,key))) fail('sharing_response_invalid');
  return value;
}

function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('sharing_response_invalid');
  return value;
}

const EMPTY = Object.freeze({ status: 'disabled',notice: '',uploadedCount: 0 });
export const E8_SHARING_DISCLOSURE = 'Sharing uploads future reports containing a random diagnostic ID, browser and operating-system category, local timing, buffer and stream behavior, and categorical signal state to this game\'s host. Reports are pseudonymous, not anonymous, and the host may recognize a device from its context. Accepted reports remain until the whole diagnostic trace is purged or expires under retention; stopping sharing does not delete reports already accepted.';

export class E8ListenerSharingController {
  constructor({ request,readLifecycle,now,uuid,scheduleInterval,cancelInterval,onChange }) {
    if (![request,readLifecycle,now,uuid,scheduleInterval,cancelInterval,onChange]
      .every((value) => typeof value === 'function')) fail();
    this.request = request;
    this.readLifecycle = readLifecycle;
    this.now = now;
    this.uuid = uuid;
    this.scheduleInterval = scheduleInterval;
    this.cancelInterval = cancelInterval;
    this.onChange = onChange;
    this.state = EMPTY;
    this.grant = null;
    this.optInIntent = null;
    this.stopRequestId = null;
    this.pendingReport = null;
    this.lastUploadedSequence = -1;
    this.timer = null;
    this.uploading = false;
    this.stopInFlight = false;
    this.operationEpoch = 0;
    this.disposed = false;
  }

  async optIn(runId) {
    if (this.disposed || ACTIVE.has(this.state.status)) return false;
    const operationEpoch = ++this.operationEpoch;
    const lifecycle = this.readLifecycle();
    const reports = summaries(lifecycle);
    if (!this.optInIntent) {
      const firstAllowedSequence = Number.isSafeInteger(lifecycle.nextSequence)
        ? lifecycle.nextSequence
        : reports.reduce((maximum,report) => Math.max(maximum,report.sequence),-1) + 1;
      this.optInIntent = Object.freeze({
        action: 'opt_in',requestId: this.uuid(),runId,
        listenerInstanceId: lifecycle.instanceId,firstAllowedSequence,
        localConsentStartedMs: this.now(),
      });
    } else if (this.optInIntent.runId !== runId
      || this.optInIntent.listenerInstanceId !== lifecycle.instanceId) fail();
    this.#publish({ ...this.state,status: 'enabling',notice: '' });
    try {
      const result = exactResult(finiteResult(await this.request(
        '/api/diagnostics/listener',this.optInIntent,
      ),['enabled']),['status','grantId','traceId','listenerInstanceId','generation','expiresAtMs']);
      if (!this.#current(operationEpoch)) return false;
      if (result.listenerInstanceId !== this.optInIntent.listenerInstanceId
        || !Number.isSafeInteger(result.generation) || result.generation < 1
        || !Number.isSafeInteger(result.expiresAtMs) || result.expiresAtMs < 0) {
        fail('sharing_response_invalid');
      }
      const acknowledgedLifecycle = this.readLifecycle();
      if (acknowledgedLifecycle.instanceId !== this.optInIntent.listenerInstanceId) {
        fail('grant_lost');
      }
      const acknowledgedNextSequence = Number.isSafeInteger(acknowledgedLifecycle.nextSequence)
        ? acknowledgedLifecycle.nextSequence
        : summaries(acknowledgedLifecycle)
          .reduce((maximum,report) => Math.max(maximum,report.sequence),-1) + 1;
      this.grant = Object.freeze({
        grantId: uuid(result.grantId),traceId: uuid(result.traceId),
        listenerInstanceId: result.listenerInstanceId,
        generation: result.generation,expiresAtMs: result.expiresAtMs,
        firstAllowedSequence: Math.max(
          this.optInIntent.firstAllowedSequence,acknowledgedNextSequence,
        ),
      });
      this.lastUploadedSequence = this.grant.firstAllowedSequence - 1;
      this.optInIntent = null;
      this.#publish({ ...this.state,status: 'enabled',notice: 'sharing_enabled' });
      this.#startTimer();
      void this.flush();
      return true;
    } catch (error) {
      if (!this.#current(operationEpoch)) return false;
      if (error?.code === 'grant_lost') this.optInIntent = null;
      this.#publish({ ...this.state,status: 'error',notice: error?.code ?? 'sharing_failed' });
      return false;
    }
  }

  async stop() {
    if (this.disposed || this.stopInFlight || !this.grant
      || this.state.status === 'disabled') return false;
    const operationEpoch = ++this.operationEpoch;
    this.stopInFlight = true;
    this.#cancelTimer();
    this.stopRequestId ??= this.uuid();
    this.#publish({ ...this.state,status: 'stopping',notice: '' });
    try {
      const result = exactResult(finiteResult(await this.request('/api/diagnostics/listener',{
        action: 'stop',requestId: this.stopRequestId,grantId: this.grant.grantId,
      }),['revoked']),['status','grantId','generation']);
      if (!this.#current(operationEpoch)) return false;
      if (result.grantId !== this.grant.grantId
        || result.generation !== this.grant.generation + 1) fail('sharing_response_invalid');
      this.grant = null;
      this.pendingReport = null;
      this.stopRequestId = null;
      this.#publish({ ...this.state,status: 'disabled',notice: 'sharing_stopped' });
      return true;
    } catch (error) {
      if (!this.#current(operationEpoch)) return false;
      this.#publish({ ...this.state,status: 'stopping',notice: error?.code ?? 'sharing_uncertain' });
      return false;
    } finally {
      this.stopInFlight = false;
    }
  }

  async flush() {
    if (this.disposed || this.uploading || this.state.status !== 'enabled' || !this.grant) {
      return false;
    }
    this.uploading = true;
    const operationEpoch = this.operationEpoch;
    let synchronizing = false;
    try {
      if (!this.pendingReport) {
        const next = summaries(this.readLifecycle()).find((report) => (
          report.instanceId === this.grant.listenerInstanceId
          && report.sequence >= this.grant.firstAllowedSequence
          && report.sequence > this.lastUploadedSequence
        ));
        if (!next) return false;
        this.pendingReport = {
          measurementCore: next,syncRequestId: this.uuid(),sampleObservation: null,
        };
      }
      if (!this.pendingReport.sampleObservation) {
        synchronizing = true;
        const localSendMs = this.now();
        const issuance = exactResult(finiteResult(await this.request('/api/diagnostics/listener',{
          action: 'synchronize',requestId: this.pendingReport.syncRequestId,
          grantId: this.grant.grantId,
        }),['accepted','replayed']),[
          'status','grantId','sampleId','timebaseId','instanceId','serverReceiveMs','serverSendMs',
        ]);
        if (!this.#current(operationEpoch)) return false;
        const localReceiveMs = this.now();
        if (issuance.grantId !== this.grant.grantId
          || issuance.timebaseId !== this.grant.traceId
          || issuance.instanceId !== this.grant.listenerInstanceId) {
          fail('sharing_response_invalid');
        }
        if (![issuance.serverReceiveMs,issuance.serverSendMs]
          .every((value) => Number.isSafeInteger(value) && value >= 0)
          || issuance.serverSendMs < issuance.serverReceiveMs
          || issuance.serverSendMs - issuance.serverReceiveMs > 2_000
          || !Number.isFinite(localSendMs) || !Number.isFinite(localReceiveMs)
          || localReceiveMs < localSendMs || localReceiveMs - localSendMs > 2_000) {
          fail('sample_invalid');
        }
        this.pendingReport.sampleObservation = Object.freeze({
          sampleId: uuid(issuance.sampleId),instanceId: this.grant.listenerInstanceId,
          localSendMs,localReceiveMs,
        });
        synchronizing = false;
      }
      const reportResult = await this.request('/api/diagnostics/listener-report',{
        grantId: this.grant.grantId,
        measurementCore: this.pendingReport.measurementCore,
        sampleObservation: this.pendingReport.sampleObservation,
      });
      if (!this.#current(operationEpoch)) return false;
      if (['sharing_disabled','trace_inactive','stale_correlation','report_conflict',
        'report_invalid','rate_limited','quota_exhausted'].includes(reportResult?.status)) {
        fail(reportResult.status);
      }
      const result = exactResult(finiteResult(reportResult,
        ['accepted','replayed']),['status','receivedAt']);
      if (!Number.isSafeInteger(result.receivedAt) || result.receivedAt < 0) {
        fail('sharing_response_invalid');
      }
      this.lastUploadedSequence = this.pendingReport.measurementCore.sequence;
      this.pendingReport = null;
      this.#publish({
        ...this.state,uploadedCount: this.state.uploadedCount + 1,notice: result.status,
      });
      return true;
    } catch (error) {
      if (!this.#current(operationEpoch)) return false;
      if (synchronizing && this.pendingReport) {
        this.pendingReport.syncRequestId = this.uuid();
      }
      if (['sharing_disabled','trace_inactive','stale_correlation','diagnostic_not_found']
        .includes(error?.code)) {
        this.#cancelTimer();
        this.grant = null;
        this.pendingReport = null;
        this.#publish({ ...this.state,status: 'disabled',notice: error.code });
      } else if (error?.code === 'report_invalid' && this.pendingReport) {
        this.pendingReport.sampleObservation = null;
        this.pendingReport.syncRequestId = this.uuid();
        this.#publish({ ...this.state,notice: error.code });
      } else if (error?.code === 'report_conflict') {
        this.#cancelTimer();
        this.#publish({ ...this.state,notice: error.code });
        void this.stop();
      } else {
        this.#publish({ ...this.state,notice: error?.code ?? 'upload_failed' });
      }
      return false;
    } finally {
      this.uploading = false;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.operationEpoch += 1;
    this.#cancelTimer();
    this.grant = null;
    this.pendingReport = null;
  }

  #startTimer() {
    if (this.timer === null) this.timer = this.scheduleInterval(() => void this.flush(),1000);
  }

  #cancelTimer() {
    if (this.timer === null) return;
    this.cancelInterval(this.timer);
    this.timer = null;
  }

  #current(operationEpoch) {
    return !this.disposed && operationEpoch === this.operationEpoch;
  }

  #publish(next) {
    this.state = Object.freeze(next);
    try { this.onChange(this.state); } catch {}
  }
}

export const E8_EMPTY_SHARING_STATE = EMPTY;
