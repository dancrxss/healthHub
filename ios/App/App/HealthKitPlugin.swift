//
//  HealthKitPlugin.swift
//  Gym Tracker
//
//  In-app Capacitor plugin bridging Apple Health into the web layer. Registered
//  by BridgeViewController via `bridge?.registerPluginInstance(...)` — it is not
//  an npm plugin and is deliberately not auto-registered.
//
//  Contract (PLAN.md §"Phase N — Native iOS shell + Apple Health"):
//    requestAuthorization()            -> { requested: true }
//    startSync({ backfillDays })       -> { started: true }
//    stopSync()                        -> { stopped: true }
//    saveWorkout({name, startedAt, endedAt, kcal}) -> { saved: Bool }
//    getStatus()                       -> { available, authorizationRequested }
//  Events:
//    "samples" -> { type: <slug>, samples: [HealthSampleRecord], done: Bool }
//
//  Health data never leaves the device: everything here is read from HealthKit
//  and handed straight to the local IndexedDB layer in the webview.
//

import Capacitor
import Foundation
import HealthKit

@objc(HealthKitPlugin)
public class HealthKitPlugin: CAPPlugin, CAPBridgedPlugin {

    // MARK: - Capacitor plugin registration

    public let identifier = "HealthKitPlugin"
    public let jsName = "HealthKit"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startSync", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSync", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveWorkout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise)
    ]

    // MARK: - Types

    /// The full permitted read set (CLAUDE.md §10 / js/db.js `HEALTH_TYPES`).
    /// Adding a case here is a flagged contract change — do not extend silently.
    private enum HealthType: String, CaseIterable {
        case workout
        case heartRate
        case restingHeartRate
        case hrv
        case vo2max
        case bodyMass
        case bodyFatPct
        case sleepAnalysis
        case activeEnergy

        /// The HealthKit type we query for this slug.
        var sampleType: HKSampleType? {
            switch self {
            case .workout:
                return HKObjectType.workoutType()
            case .heartRate:
                return HKQuantityType.quantityType(forIdentifier: .heartRate)
            case .restingHeartRate:
                return HKQuantityType.quantityType(forIdentifier: .restingHeartRate)
            case .hrv:
                return HKQuantityType.quantityType(forIdentifier: .heartRateVariabilitySDNN)
            case .vo2max:
                return HKQuantityType.quantityType(forIdentifier: .vo2Max)
            case .bodyMass:
                return HKQuantityType.quantityType(forIdentifier: .bodyMass)
            case .bodyFatPct:
                return HKQuantityType.quantityType(forIdentifier: .bodyFatPercentage)
            case .sleepAnalysis:
                return HKObjectType.categoryType(forIdentifier: .sleepAnalysis)
            case .activeEnergy:
                return HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)
            }
        }

        /// Canonical HealthKit unit a raw quantity sample is read in. Nil for
        /// types whose value is a duration (workout, sleep) or a daily total
        /// handled separately (activeEnergy).
        var quantityUnit: HKUnit? {
            switch self {
            case .heartRate, .restingHeartRate:
                return HKUnit.count().unitDivided(by: HKUnit.minute())
            case .hrv:
                return HKUnit.secondUnit(with: .milli)
            case .vo2max:
                // ml/(kg·min)
                return HKUnit(from: "ml/kg*min")
            case .bodyMass:
                return HKUnit.gramUnit(with: .kilo)
            case .bodyFatPct:
                return HKUnit.percent()
            case .activeEnergy:
                return HKUnit.kilocalorie()
            case .workout, .sleepAnalysis:
                return nil
            }
        }

        /// Canonical unit label written into the stored record.
        var unitLabel: String {
            switch self {
            case .workout, .sleepAnalysis: return "s"
            case .heartRate, .restingHeartRate: return "bpm"
            case .hrv: return "ms"
            case .vo2max: return "ml/kg/min"
            case .bodyMass: return "kg"
            case .bodyFatPct: return "%"
            case .activeEnergy: return "kcal"
            }
        }

        /// Per-type backfill cap in days (pinned contract).
        var maxBackfillDays: Int {
            switch self {
            case .heartRate: return 30
            case .sleepAnalysis: return 90
            default: return 365
            }
        }

        /// Background-delivery frequency.
        var updateFrequency: HKUpdateFrequency {
            switch self {
            case .workout, .sleepAnalysis: return .immediate
            default: return .hourly
            }
        }
    }

    // MARK: - State

    private let store = HKHealthStore()
    /// Serial queue for anchor bookkeeping and batch assembly; HealthKit
    /// callbacks arrive on its own background queues.
    private let work = DispatchQueue(label: "com.dancross.gymtracker.healthkit", qos: .utility)
    private var observerQueries: [String: HKObserverQuery] = [:]
    private var activeEnergyQuery: HKStatisticsCollectionQuery?
    /// Backfill window requested by JS, capped per type.
    private var requestedBackfillDays = 365
    private var syncing = false

    private static let anchorKeyPrefix = "gymtracker.health.anchor."
    private static let authRequestedKey = "gymtracker.health.authorizationRequested"
    private static let maxBatchSize = 500

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(secondsFromGMT: 0)
        return f
    }()

    /// Read set — the pinned contract. No additions without flagging it.
    private static var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = [HKObjectType.workoutType()]
        for type in HealthType.allCases where type != .workout {
            if let sampleType = type.sampleType {
                types.insert(sampleType)
            }
        }
        return types
    }

    /// Write set — workouts and the energy they burned, nothing else.
    private static var shareTypes: Set<HKSampleType> {
        var types: Set<HKSampleType> = [HKObjectType.workoutType()]
        if let energy = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned) {
            types.insert(energy)
        }
        return types
    }

    // MARK: - Plugin methods

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("Apple Health is not available on this device")
            return
        }
        store.requestAuthorization(toShare: Self.shareTypes, read: Self.readTypes) { _, error in
            if let error = error {
                call.reject("Apple Health authorisation failed: \(error.localizedDescription)")
                return
            }
            // The sheet completed. Read grants are deliberately invisible —
            // never report grant state, only that we asked.
            UserDefaults.standard.set(true, forKey: Self.authRequestedKey)
            call.resolve(["requested": true])
        }
    }

    @objc func startSync(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("Apple Health is not available on this device")
            return
        }
        let requested = call.getInt("backfillDays") ?? 365
        requestedBackfillDays = max(1, requested)
        syncing = true

        work.async { [weak self] in
            guard let self = self else { return }
            for type in HealthType.allCases {
                if type == .activeEnergy {
                    self.startActiveEnergySync()
                } else {
                    self.runAnchoredQuery(for: type) {
                        self.startObserving(type)
                    }
                }
            }
        }
        call.resolve(["started": true])
    }

    @objc func stopSync(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("Apple Health is not available on this device")
            return
        }
        syncing = false
        store.disableAllBackgroundDelivery { _, error in
            if let error = error {
                CAPLog.print("⚡️  HealthKit: disabling background delivery failed: \(error.localizedDescription)")
            }
        }
        work.async { [weak self] in
            guard let self = self else { return }
            for (_, query) in self.observerQueries {
                self.store.stop(query)
            }
            self.observerQueries.removeAll()
            if let query = self.activeEnergyQuery {
                self.store.stop(query)
                self.activeEnergyQuery = nil
            }
            for type in HealthType.allCases {
                UserDefaults.standard.removeObject(forKey: Self.anchorKey(type))
            }
        }
        call.resolve(["stopped": true])
    }

    @objc func saveWorkout(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("Apple Health is not available on this device")
            return
        }
        guard let startedAt = call.getString("startedAt"),
              let start = Self.parseDate(startedAt) else {
            call.reject("Must provide startedAt as an ISO datetime")
            return
        }
        guard let endedAt = call.getString("endedAt"),
              let end = Self.parseDate(endedAt) else {
            call.reject("Must provide endedAt as an ISO datetime")
            return
        }
        guard end >= start else {
            call.reject("endedAt must not be before startedAt")
            return
        }
        guard store.authorizationStatus(for: HKObjectType.workoutType()) == .sharingAuthorized else {
            call.reject("Gym Tracker is not allowed to write workouts to Apple Health")
            return
        }

        let name = call.getString("name")
        let kcal = call.getDouble("kcal")

        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .traditionalStrengthTraining
        let builder = HKWorkoutBuilder(healthStore: store, configuration: configuration, device: .local())

        let fail: (String) -> Void = { message in
            CAPLog.print("⚡️  HealthKit: saveWorkout failed — \(message)")
            call.resolve(["saved": false])
        }

        builder.beginCollection(withStart: start) { started, error in
            guard started else {
                fail(error?.localizedDescription ?? "beginCollection returned false")
                return
            }

            let finish: () -> Void = {
                builder.endCollection(withEnd: end) { ended, error in
                    guard ended else {
                        fail(error?.localizedDescription ?? "endCollection returned false")
                        return
                    }
                    builder.finishWorkout { workout, error in
                        if let error = error {
                            fail(error.localizedDescription)
                            return
                        }
                        call.resolve(["saved": workout != nil])
                    }
                }
            }

            let addEnergy: () -> Void = {
                guard let kcal = kcal, kcal > 0,
                      let energyType = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned),
                      self.store.authorizationStatus(for: energyType) == .sharingAuthorized else {
                    finish()
                    return
                }
                let quantity = HKQuantity(unit: .kilocalorie(), doubleValue: kcal)
                let sample = HKQuantitySample(type: energyType, quantity: quantity, start: start, end: end)
                builder.add([sample]) { _, error in
                    if let error = error {
                        CAPLog.print("⚡️  HealthKit: could not attach energy to workout — \(error.localizedDescription)")
                    }
                    finish()
                }
            }

            if let name = name, !name.isEmpty {
                // Custom metadata keys are permitted; keeps the session name
                // visible in Health without pretending to be a system key.
                builder.addMetadata(["GymTrackerWorkoutName": name]) { _, error in
                    if let error = error {
                        CAPLog.print("⚡️  HealthKit: could not attach workout name — \(error.localizedDescription)")
                    }
                    addEnergy()
                }
            } else {
                addEnergy()
            }
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve([
            "available": HKHealthStore.isHealthDataAvailable(),
            "authorizationRequested": UserDefaults.standard.bool(forKey: Self.authRequestedKey)
        ])
    }

    // MARK: - Anchored queries

    /// Runs one anchored query for `type`, emits its results as `samples`
    /// events, persists the new anchor, then calls `completion`. With no stored
    /// anchor this is the bounded backfill; afterwards it is a delta.
    private func runAnchoredQuery(for type: HealthType, completion: (() -> Void)? = nil) {
        guard type != .activeEnergy, let sampleType = type.sampleType else {
            completion?()
            return
        }
        let anchor = loadAnchor(type)
        let predicate: NSPredicate? = anchor == nil
            ? HKQuery.predicateForSamples(withStart: backfillStart(for: type), end: nil, options: [.strictStartDate])
            : nil

        let query = HKAnchoredObjectQuery(
            type: sampleType,
            predicate: predicate,
            anchor: anchor,
            limit: HKObjectQueryNoLimit
        ) { [weak self] _, samples, _, newAnchor, error in
            guard let self = self else {
                completion?()
                return
            }
            if let error = error {
                CAPLog.print("⚡️  HealthKit: \(type.rawValue) query failed — \(error.localizedDescription)")
                self.emit(type: type, batch: [], done: true)
                completion?()
                return
            }
            if let newAnchor = newAnchor {
                self.saveAnchor(newAnchor, for: type)
            }
            self.mapAndEmit(type: type, samples: samples ?? []) {
                completion?()
            }
        }
        store.execute(query)
    }

    /// Observer query + background delivery for one type. The observer's
    /// completion handler is always called once the delta has been processed —
    /// HealthKit will keep re-notifying until it is.
    private func startObserving(_ type: HealthType) {
        guard let sampleType = type.sampleType else { return }
        work.async { [weak self] in
            guard let self = self, self.syncing, self.observerQueries[type.rawValue] == nil else { return }

            let query = HKObserverQuery(sampleType: sampleType, predicate: nil) { [weak self] _, completionHandler, error in
                guard let self = self else {
                    completionHandler()
                    return
                }
                if let error = error {
                    CAPLog.print("⚡️  HealthKit: observer for \(type.rawValue) failed — \(error.localizedDescription)")
                    completionHandler()
                    return
                }
                if type == .activeEnergy {
                    // Daily totals are refreshed by the statistics collection
                    // query's own update handler; the observer exists purely so
                    // background delivery has something to wake.
                    completionHandler()
                    return
                }
                self.runAnchoredQuery(for: type) {
                    completionHandler()
                }
            }
            self.observerQueries[type.rawValue] = query
            self.store.execute(query)
            self.store.enableBackgroundDelivery(for: sampleType, frequency: type.updateFrequency) { _, error in
                if let error = error {
                    CAPLog.print("⚡️  HealthKit: background delivery for \(type.rawValue) failed — \(error.localizedDescription)")
                }
            }
        }
    }

    // MARK: - Active energy (daily totals)

    /// Active energy is stored as one daily total per *local* calendar day,
    /// with a deterministic id so re-emitting a day is an idempotent upsert.
    /// Day buckets come from `Calendar.current`, matching the JS side's
    /// local-date helper.
    private func startActiveEnergySync() {
        guard activeEnergyQuery == nil,
              let energyType = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned) else { return }

        let start = Calendar.current.startOfDay(for: backfillStart(for: .activeEnergy))
        let predicate = HKQuery.predicateForSamples(withStart: start, end: nil, options: [.strictStartDate])
        let query = HKStatisticsCollectionQuery(
            quantityType: energyType,
            quantitySamplePredicate: predicate,
            options: .cumulativeSum,
            anchorDate: start,
            intervalComponents: DateComponents(day: 1)
        )

        query.initialResultsHandler = { [weak self] _, collection, error in
            guard let self = self else { return }
            if let error = error {
                CAPLog.print("⚡️  HealthKit: activeEnergy query failed — \(error.localizedDescription)")
                self.emit(type: .activeEnergy, batch: [], done: true)
                return
            }
            guard let collection = collection else {
                self.emit(type: .activeEnergy, batch: [], done: true)
                return
            }
            var payloads: [[String: Any]] = []
            collection.enumerateStatistics(from: start, to: Date()) { statistics, _ in
                if let payload = self.activeEnergyPayload(statistics) {
                    payloads.append(payload)
                }
            }
            self.emitBatched(type: .activeEnergy, payloads: payloads)
        }

        query.statisticsUpdateHandler = { [weak self] _, statistics, _, error in
            guard let self = self else { return }
            if let error = error {
                CAPLog.print("⚡️  HealthKit: activeEnergy update failed — \(error.localizedDescription)")
                return
            }
            guard let statistics = statistics,
                  let payload = self.activeEnergyPayload(statistics) else { return }
            self.emit(type: .activeEnergy, batch: [payload], done: true)
        }

        activeEnergyQuery = query
        store.execute(query)
        startObserving(.activeEnergy)
    }

    private func activeEnergyPayload(_ statistics: HKStatistics) -> [String: Any]? {
        guard let sum = statistics.sumQuantity() else { return nil }
        let kcal = sum.doubleValue(for: .kilocalorie())
        guard kcal.isFinite else { return nil }
        let day = Self.localDayString(statistics.startDate)
        return [
            "id": "activeEnergy-\(day)",
            "type": HealthType.activeEnergy.rawValue,
            "startedAt": Self.iso(statistics.startDate),
            "endedAt": Self.iso(statistics.endDate),
            "value": kcal,
            "unit": HealthType.activeEnergy.unitLabel,
            "meta": NSNull()
        ]
    }

    // MARK: - Mapping

    private func mapAndEmit(type: HealthType, samples: [HKSample], completion: @escaping () -> Void) {
        guard !samples.isEmpty else {
            emit(type: type, batch: [], done: true)
            completion()
            return
        }
        if type == .workout {
            let workouts = samples.compactMap { $0 as? HKWorkout }
            buildWorkoutPayloads(workouts) { [weak self] payloads in
                self?.emitBatched(type: type, payloads: payloads)
                completion()
            }
            return
        }
        let payloads = samples.compactMap { payload(for: $0, type: type) }
        emitBatched(type: type, payloads: payloads)
        completion()
    }

    /// Maps a quantity or category sample to the `HealthSampleRecord` shape
    /// documented in js/db.js.
    private func payload(for sample: HKSample, type: HealthType) -> [String: Any]? {
        var value: Double
        var meta: Any = NSNull()

        switch type {
        case .sleepAnalysis:
            guard let category = sample as? HKCategorySample else { return nil }
            value = category.endDate.timeIntervalSince(category.startDate)
            meta = ["stage": Self.sleepStage(category.value)]
        case .workout:
            return nil // handled by buildWorkoutPayloads
        default:
            guard let quantity = sample as? HKQuantitySample, let unit = type.quantityUnit else { return nil }
            value = quantity.quantity.doubleValue(for: unit)
            if type == .bodyFatPct {
                // HKUnit.percent() reads 0–1; the stored contract is 0–100.
                value *= 100
            }
        }

        guard value.isFinite else { return nil }
        return [
            "id": sample.uuid.uuidString,
            "type": type.rawValue,
            "startedAt": Self.iso(sample.startDate),
            "endedAt": Self.iso(sample.endDate),
            "value": value,
            "unit": type.unitLabel,
            "meta": meta
        ]
    }

    /// Workouts need an average heart rate, which is its own statistics query.
    /// Results are collected in the original order and emitted as one run, so
    /// event ordering stays sane. Concurrency is bounded so a 365-day backfill
    /// doesn't fire hundreds of simultaneous queries.
    private func buildWorkoutPayloads(_ workouts: [HKWorkout], completion: @escaping ([[String: Any]]) -> Void) {
        guard !workouts.isEmpty else {
            completion([])
            return
        }
        work.async { [weak self] in
            guard let self = self else {
                completion([])
                return
            }
            var results = [[String: Any]?](repeating: nil, count: workouts.count)
            let lock = NSLock()
            let group = DispatchGroup()
            let limit = DispatchSemaphore(value: 4)

            for (index, workout) in workouts.enumerated() {
                limit.wait()
                group.enter()
                self.averageHeartRate(for: workout) { average in
                    let payload = self.workoutPayload(workout, avgHeartRate: average)
                    lock.lock()
                    results[index] = payload
                    lock.unlock()
                    limit.signal()
                    group.leave()
                }
            }

            group.notify(queue: self.work) {
                completion(results.compactMap { $0 })
            }
        }
    }

    private func workoutPayload(_ workout: HKWorkout, avgHeartRate: Double?) -> [String: Any] {
        var meta: [String: Any] = [
            "activityType": Self.activityName(workout.workoutActivityType),
            "kcal": NSNull(),
            "distanceM": NSNull(),
            "avgHeartRate": NSNull()
        ]

        if let energyType = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned),
           let kcal = workout.statistics(for: energyType)?.sumQuantity()?.doubleValue(for: .kilocalorie()),
           kcal.isFinite {
            meta["kcal"] = kcal
        }

        let distanceIdentifiers: [HKQuantityTypeIdentifier] = [
            .distanceWalkingRunning,
            .distanceCycling,
            .distanceSwimming,
            .distanceWheelchair,
            .distanceDownhillSnowSports
        ]
        for identifier in distanceIdentifiers {
            guard let distanceType = HKQuantityType.quantityType(forIdentifier: identifier),
                  let metres = workout.statistics(for: distanceType)?.sumQuantity()?.doubleValue(for: .meter()),
                  metres.isFinite else { continue }
            meta["distanceM"] = metres
            break
        }

        if let avgHeartRate = avgHeartRate, avgHeartRate.isFinite {
            meta["avgHeartRate"] = avgHeartRate
        }

        return [
            "id": workout.uuid.uuidString,
            "type": HealthType.workout.rawValue,
            "startedAt": Self.iso(workout.startDate),
            "endedAt": Self.iso(workout.endDate),
            "value": workout.duration,
            "unit": HealthType.workout.unitLabel,
            "meta": meta
        ]
    }

    private func averageHeartRate(for workout: HKWorkout, completion: @escaping (Double?) -> Void) {
        guard let heartRateType = HKQuantityType.quantityType(forIdentifier: .heartRate) else {
            completion(nil)
            return
        }
        let predicate = HKQuery.predicateForSamples(
            withStart: workout.startDate,
            end: workout.endDate,
            options: [.strictStartDate]
        )
        let query = HKStatisticsQuery(
            quantityType: heartRateType,
            quantitySamplePredicate: predicate,
            options: .discreteAverage
        ) { _, statistics, _ in
            let bpm = HKUnit.count().unitDivided(by: HKUnit.minute())
            completion(statistics?.averageQuantity()?.doubleValue(for: bpm))
        }
        store.execute(query)
    }

    // MARK: - Emitting

    private func emitBatched(type: HealthType, payloads: [[String: Any]]) {
        guard !payloads.isEmpty else {
            emit(type: type, batch: [], done: true)
            return
        }
        var index = 0
        while index < payloads.count {
            let end = min(index + Self.maxBatchSize, payloads.count)
            let batch = Array(payloads[index..<end])
            emit(type: type, batch: batch, done: end >= payloads.count)
            index = end
        }
    }

    private func emit(type: HealthType, batch: [[String: Any]], done: Bool) {
        // Retained until consumed so batches produced by a background wake-up
        // aren't lost when the webview attaches its listener a moment later.
        notifyListeners(
            "samples",
            data: [
                "type": type.rawValue,
                "samples": batch,
                "done": done
            ],
            retainUntilConsumed: true
        )
    }

    // MARK: - Anchors

    private static func anchorKey(_ type: HealthType) -> String {
        return anchorKeyPrefix + type.rawValue
    }

    private func loadAnchor(_ type: HealthType) -> HKQueryAnchor? {
        guard let data = UserDefaults.standard.data(forKey: Self.anchorKey(type)) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private func saveAnchor(_ anchor: HKQueryAnchor, for type: HealthType) {
        guard let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true) else { return }
        UserDefaults.standard.set(data, forKey: Self.anchorKey(type))
    }

    private func backfillStart(for type: HealthType) -> Date {
        let days = min(type.maxBackfillDays, requestedBackfillDays)
        return Date().addingTimeInterval(-Double(days) * 86_400)
    }

    // MARK: - Formatting helpers

    private static func iso(_ date: Date) -> String {
        return isoFormatter.string(from: date)
    }

    /// "YYYY-MM-DD" in the device's local calendar — the id key for daily
    /// active-energy totals. Built from DateComponents so it is thread-safe and
    /// never picks up a stale time zone.
    private static func localDayString(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    private static func parseDate(_ value: String) -> Date? {
        if let date = isoFormatter.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        plain.timeZone = TimeZone(secondsFromGMT: 0)
        return plain.date(from: value)
    }

    private static func sleepStage(_ value: Int) -> String {
        guard let category = HKCategoryValueSleepAnalysis(rawValue: value) else { return "asleepCore" }
        switch category {
        case .inBed: return "inBed"
        case .awake: return "awake"
        case .asleepCore: return "asleepCore"
        case .asleepDeep: return "asleepDeep"
        case .asleepREM: return "asleepREM"
        default:
            // .asleepUnspecified (and anything newer) collapses to core sleep.
            return "asleepCore"
        }
    }

    /// Readable activity name, e.g. "traditionalStrengthTraining". Unmapped
    /// activity types fall back to "other".
    private static func activityName(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .americanFootball: return "americanFootball"
        case .archery: return "archery"
        case .australianFootball: return "australianFootball"
        case .badminton: return "badminton"
        case .barre: return "barre"
        case .baseball: return "baseball"
        case .basketball: return "basketball"
        case .bowling: return "bowling"
        case .boxing: return "boxing"
        case .cardioDance: return "cardioDance"
        case .climbing: return "climbing"
        case .cooldown: return "cooldown"
        case .coreTraining: return "coreTraining"
        case .cricket: return "cricket"
        case .crossCountrySkiing: return "crossCountrySkiing"
        case .crossTraining: return "crossTraining"
        case .curling: return "curling"
        case .cycling: return "cycling"
        case .discSports: return "discSports"
        case .downhillSkiing: return "downhillSkiing"
        case .elliptical: return "elliptical"
        case .equestrianSports: return "equestrianSports"
        case .fencing: return "fencing"
        case .fishing: return "fishing"
        case .fitnessGaming: return "fitnessGaming"
        case .flexibility: return "flexibility"
        case .functionalStrengthTraining: return "functionalStrengthTraining"
        case .golf: return "golf"
        case .gymnastics: return "gymnastics"
        case .handball: return "handball"
        case .handCycling: return "handCycling"
        case .highIntensityIntervalTraining: return "highIntensityIntervalTraining"
        case .hiking: return "hiking"
        case .hockey: return "hockey"
        case .hunting: return "hunting"
        case .jumpRope: return "jumpRope"
        case .kickboxing: return "kickboxing"
        case .lacrosse: return "lacrosse"
        case .martialArts: return "martialArts"
        case .mindAndBody: return "mindAndBody"
        case .mixedCardio: return "mixedCardio"
        case .paddleSports: return "paddleSports"
        case .pilates: return "pilates"
        case .play: return "play"
        case .preparationAndRecovery: return "preparationAndRecovery"
        case .racquetball: return "racquetball"
        case .rowing: return "rowing"
        case .rugby: return "rugby"
        case .running: return "running"
        case .sailing: return "sailing"
        case .skatingSports: return "skatingSports"
        case .snowboarding: return "snowboarding"
        case .soccer: return "soccer"
        case .socialDance: return "socialDance"
        case .softball: return "softball"
        case .squash: return "squash"
        case .stairClimbing: return "stairClimbing"
        case .stairs: return "stairs"
        case .stepTraining: return "stepTraining"
        case .surfingSports: return "surfingSports"
        case .swimming: return "swimming"
        case .swimBikeRun: return "swimBikeRun"
        case .tableTennis: return "tableTennis"
        case .taiChi: return "taiChi"
        case .tennis: return "tennis"
        case .trackAndField: return "trackAndField"
        case .traditionalStrengthTraining: return "traditionalStrengthTraining"
        case .transition: return "transition"
        case .underwaterDiving: return "underwaterDiving"
        case .volleyball: return "volleyball"
        case .walking: return "walking"
        case .waterFitness: return "waterFitness"
        case .waterPolo: return "waterPolo"
        case .waterSports: return "waterSports"
        case .wheelchairRunPace: return "wheelchairRunPace"
        case .wheelchairWalkPace: return "wheelchairWalkPace"
        case .wrestling: return "wrestling"
        case .yoga: return "yoga"
        default: return "other"
        }
    }
}
