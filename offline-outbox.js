/* Crew Clock V30: durable, immutable outbox. No authentication credentials stored here. */
(function (root) {
  "use strict";
  const clone = value => JSON.parse(JSON.stringify(value));
  const stable = value => JSON.stringify(sort(value));
  function sort(value) {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
    return value;
  }
  const keyFor = p => JSON.stringify([p.worker, p.clientShiftId]);
  class Outbox {
    constructor(options = {}) {
      this.indexedDB = options.indexedDB || root.indexedDB;
      this.name = options.name || "pga-crew-clock-outbox-v30";
      this.now = options.now || Date.now;
      this.owner = options.owner || `${Date.now()}-${Math.random()}`;
      this.db = null;
      this.opening = null;
      this.version = options.version || 2;
      this.store = options.store || "entries";
      if (!["entries", "starts"].includes(this.store)) throw new Error("Invalid outbox store");
      this.running = null;
    }
    async open() {
      if (this.db) return;
      if (this.opening) return this.opening;
      if (!this.indexedDB) throw new Error("IndexedDB is unavailable. Clock-out has NOT been recorded locally.");
      this.opening = new Promise((resolve, reject) => {
        let failed = false;
        const fail = error => { failed = true; reject(error); };
        const req = this.indexedDB.open(this.name, this.version);
        req.onupgradeneeded = () => {
          if (failed) { req.transaction.abort(); return; }
          // Additive migrations only. Existing stores and records are never recreated.
          for (const name of ["entries", "conflicts", "meta", ...(this.version >= 2 ? ["starts"] : [])]) {
            if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: "key" });
            else if (req.transaction.objectStore(name).keyPath !== "key") {
              fail(new Error("Unrecognized local database schema. Existing records were not changed; office review required."));
              req.transaction.abort();
              return;
            }
          }
        };
        req.onerror = () => fail(req.error);
        req.onblocked = () => fail(new Error("Local database upgrade blocked. Preserve other Crew Clock tabs before closing them; reopen this app after review."));
        req.onsuccess = () => {
          if (failed) { req.result.close(); return; }
          const required = ["entries", "conflicts", "meta", ...(this.version >= 2 ? ["starts"] : [])];
          if (required.some(name => !req.result.objectStoreNames.contains(name))) {
            req.result.close();
            fail(new Error("Local database stores are missing. Existing data was left untouched."));
            return;
          }
          const check = req.result.transaction(required, "readonly");
          if (required.some(name => check.objectStore(name).keyPath !== "key")) {
            req.result.close();
            fail(new Error("Unrecognized local database keys. Existing data was left untouched."));
            return;
          }
          req.result.onversionchange = () => { req.result.close(); this.db = null; };
          this.db = req.result;
          resolve(req.result);
        };
      });
      try { await this.opening; } finally { this.opening = null; }
    }
    async transaction(stores, mode, work) {
      await this.open();
      return new Promise((resolve, reject) => {
        let result;
        const tx = this.db.transaction(stores, mode);
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error("Local database transaction failed"));
        try { work(tx, value => { result = value; }); } catch (error) { tx.abort(); reject(error); }
      });
    }
    async list() {
      return this.transaction([this.store], "readonly", (tx, done) => {
        tx.objectStore(this.store).getAll().onsuccess = e => done(e.target.result);
      });
    }
    async meta(key, value) {
      return this.transaction(["meta"], value === undefined ? "readonly" : "readwrite", (tx, done) => {
        const store = tx.objectStore("meta");
        if (value !== undefined) store.put({ key, value: clone(value) });
        else store.get(key).onsuccess = e => done(e.target.result?.value);
      });
    }
    async enqueue(shift, payload, schedule = null, options = {}) {
      const isStart = this.store === "starts";
      if (!payload.clientShiftId || !payload.worker || !payload.startIso || (isStart ? !payload.deviceId || !payload.jobsite : !payload.endIso || !["Yes", "No"].includes(payload.lunch))) throw new Error("Incomplete shift. It has NOT been recorded locally.");
      const key = keyFor(payload);
      const immutable = { payload: clone(payload), schedule: schedule ? clone(schedule) : null };
      const result = await this.transaction([this.store, "conflicts", ...(isStart ? ["entries"] : [])], "readwrite", (tx, done) => {
        const entries = tx.objectStore(this.store);
        entries.get(key).onsuccess = e => {
          const existing = e.target.result;
          if (existing) {
            if (stable(existing.immutable) !== stable(immutable)) {
              tx.objectStore("conflicts").put({ key: `${this.store}:${key}:${this.now()}:${Math.random()}`, store: this.store, entryKey: key, shift: clone(shift), immutable, capturedAt: this.now() });
              existing.status = "attention";
              existing.blocked = true;
              existing.error = "Conflicting records for the same session. Original and alternate records preserved; office review required.";
              entries.put(existing);
            }
            done(existing);
            return;
          }
          const entry = { key, immutable, shift: clone(shift), status: "queued", attempts: 0, nextAttempt: 0, capturedAt: this.now(), verifyOnly: !!options.verifyOnly, error: "", leaseUntil: 0 };
          if (isStart) {
            entries.getAll().onsuccess = event => {
              const starts = event.target.result;
              tx.objectStore("entries").getAll().onsuccess = completed => {
                if (starts.some(r => r.shift.worker === shift.worker && !completed.target.result.some(end => end.shift.worker === shift.worker && end.shift.id === r.shift.id))) {
                  done({blocked:true,error:"Another clock-in is active on this device. Reopen that shift; no additional clock-in was recorded."});
                  return;
                }
                entries.put(entry);done(entry);
              };
            };
          } else { entries.put(entry);done(entry); }
        };
      });
      if (result.blocked) throw new Error(result.error);
      return result;
    }
    async claim(worker, manual = false, excluded = new Set()) {
      return this.transaction([this.store], "readwrite", (tx, done) => {
        const entries = tx.objectStore(this.store);
        entries.getAll().onsuccess = e => {
          const now = this.now();
          const row = e.target.result.filter(r => !excluded.has(r.key) && r.immutable.payload.worker === worker && r.status !== "saved" && !r.blocked && (r.leaseUntil || 0) <= now && (manual || r.status !== "attention") && (manual || r.nextAttempt <= now))
            .sort((a, b) => a.capturedAt - b.capturedAt)[0];
          if (!row) return done(null);
          row.lease = `${this.owner}:${now}:${Math.random()}`;
          row.leaseUntil = now + 60000;
          row.status = "sending";
          row.attempts++;
          entries.put(row);
          done(row);
        };
      });
    }
    async finish(entry, patch) {
      return this.transaction([this.store], "readwrite", (tx, done) => {
        const store = tx.objectStore(this.store);
        store.get(entry.key).onsuccess = e => {
          const current = e.target.result;
          if (!current || current.lease !== entry.lease || current.blocked) return done(current);
          Object.assign(current, patch, { lease: null, leaseUntil: 0 });
          store.put(current);
          done(current);
        };
      });
    }
    async owns(entry) {
      return this.transaction([this.store], "readonly", (tx, done) => {
        tx.objectStore(this.store).get(entry.key).onsuccess = e => {
          const current = e.target.result;
          done(!!current && !current.blocked && current.lease === entry.lease && current.leaseUntil > this.now() && stable(current.immutable) === stable(entry.immutable));
        };
      });
    }
    async reviewSnapshot(worker, sessionId) {
      const key = keyFor({ worker, clientShiftId: sessionId });
      return this.transaction([this.store, "conflicts"], "readonly", (tx, done) => {
        const result = { schemaVersion: this.version, capturedAt: this.now(), key, original: null, alternatives: [] };
        tx.objectStore(this.store).get(key).onsuccess = e => { result.original = e.target.result || null; done(result); };
        tx.objectStore("conflicts").getAll().onsuccess = e => { result.alternatives = e.target.result.filter(r => (!r.store || r.store === this.store) && (r.entryKey === key || r.key.startsWith(key + ":"))); done(result); };
      });
    }
    static verifyShift(data, payload) {
      const receipt = data?.receipt;
      const expectedId = `CC-${payload.date.replace(/[^0-9]/g, "")}-${payload.clientShiftId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
      if (data?.ok !== true || !receipt || receipt.version !== 30 || data.submissionId !== expectedId || receipt.submissionId !== expectedId || receipt.sessionId !== payload.clientShiftId || stable(receipt.payload) !== stable(payload)) {
        const error = new Error("Server receipt missing or does not match the original shift. Local record retained.");
        error.needsAttention = true;
        throw error;
      }
      return receipt;
    }
    static verifyStart(data, payload) {
      const receipt = data?.receipt;
      if (data?.ok !== true || receipt?.version !== 30 || receipt?.type !== "clockIn" || receipt.sessionId !== payload.clientShiftId || stable(receipt.payload) !== stable(payload)) {
        throw Object.assign(new Error("Clock-in receipt missing or mismatched. Original clock-in retained for office review."), { needsAttention: true });
      }
      return receipt;
    }
    static scheduleProof(report) {
      return Object.fromEntries(["scheduleId", "date", "jobsite", "scheduledStart", "scheduledEnd", "reportedBy", "sourceSubmissionId"].map(k => [k, report[k] || ""]));
    }
    static verifySchedule(data, report) {
      if (data?.ok !== true || data.receipt?.version !== 30 || data.scheduleId !== report.scheduleId || stable(data.receipt.report) !== stable(Outbox.scheduleProof(report))) {
        const error = new Error("Crew schedule receipt does not match. Confirmation preserved for retry.");
        error.needsAttention = true;
        throw error;
      }
    }
    async drain(worker, send, options = {}) {
      if (this.running) {
        const running = this.running;
        if (!options.manual) return running;
        await running;
        return this.drain(worker, send, options);
      }
      this.running = this.run(worker, send, options).finally(() => { this.running = null; });
      return this.running;
    }
    async run(worker, send, options) {
      // Each record is attempted at most once per drain, even under manual retry.
      const visited = new Set(options.exclude || []);
      let attempted = 0;
      for (;;) {
        if (options.maxEntries && attempted >= options.maxEntries) break;
        if (options.canSend && !options.canSend(worker)) break;
        const entry = await this.claim(worker, !!options.manual, visited);
        if (!entry) break;
        visited.add(entry.key);
        attempted++;
        let receipt = entry.receipt;
        try {
          if (!(await this.owns(entry)) || options.canSend && !options.canSend(worker)) continue;
          if (this.store === "starts") {
            const data = await send("saveClockIn", { clockIn: clone(entry.immutable.payload), clientProtocol: 30 });
            receipt = Outbox.verifyStart(data, entry.immutable.payload);
            await this.finish(entry, { status: "saved", receipt, savedAt: this.now(), error: "" });
            if (options.onChange) await options.onChange();
            continue;
          }
          // Re-send the same immutable shift to reconcile a lost acknowledgement or cleanup failure.
          const data = await send("saveShift", { shift: clone(entry.immutable.payload), clientProtocol: 30, verifyOnly: entry.verifyOnly });
          receipt = Outbox.verifyShift(data, entry.immutable.payload);
          if (entry.immutable.schedule) {
            // A late response must not initiate another request after conflict, lease takeover or logout.
            if (!(await this.owns(entry)) || options.canSend && !options.canSend(worker)) continue;
            const report = { ...clone(entry.immutable.schedule), sourceSubmissionId: data.submissionId };
            const scheduleData = await send("saveCrewScheduleReport", { report, clientProtocol: 30, verifyOnly: entry.verifyOnly });
            Outbox.verifySchedule(scheduleData, report);
          }
          if (data.openShiftCleanup?.ok === false) throw new Error("Hours received; open-shift cleanup pending. Retrying safely.");
          await this.finish(entry, { status: "saved", receipt, savedAt: this.now(), error: "" });
        } catch (error) {
          const attention = !!(error.needsAttention || error.isBackendError && !error.retryable);
          const delay = Math.min(300000, 2000 * 2 ** Math.min(entry.attempts, 7)) + Math.floor(Math.random() * 1000);
          await this.finish(entry, { status: attention ? "attention" : "queued", receipt, error: error.message || String(error), nextAttempt: this.now() + delay });
          if (options.onError) options.onError(error, entry);
        }
        if (options.onChange) await options.onChange();
      }
    }
  }
  Outbox.stable = stable;
  root.CrewClockOutbox = Outbox;
  if (typeof module !== "undefined") module.exports = Outbox;
})(typeof window !== "undefined" ? window : globalThis);
