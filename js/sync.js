// Sync adapter seam. Local-only mode works before any Azure resources exist;
// Phase 2 wires AzureTableAdapter to real Table Storage behind the same
// interface. Written and owned by the orchestrator — implementation agents
// should not edit this file.
//
// Adapter interface — every adapter implements:
//   name                              string
//   async push(changes)               changes: {exercises, workouts, sets, templates}
//                                     (arrays of records with syncedAt === null).
//                                     Returns {pushed: number}.
//   async pull(since)                 since: ISO datetime|null. Returns
//                                     {exercises, workouts, sets, templates} arrays
//                                     of remote records changed after `since`.
//   async status()                    {mode, configured, lastError}

/** Default adapter: local-only, no-op. The app is fully functional with it. */
export class LocalNoopAdapter {
  name = 'local';
  async push(_changes) {
    return { pushed: 0 };
  }
  async pull(_since) {
    return { exercises: [], workouts: [], sets: [], templates: [] };
  }
  async status() {
    return { mode: 'local', configured: true, lastError: null };
  }
}

/**
 * Azure Table Storage adapter — STUB. Encodes the spec's partition/row key
 * scheme now so the mapping is frozen, but performs no network calls: no Azure
 * resources exist yet (Phase 2). Selecting it without configuration throws.
 */
export class AzureTableAdapter {
  name = 'azure-tables';
  /** @param {{accountUrl?: string, sasToken?: string}} [config] */
  constructor(config = {}) {
    this.config = config;
  }

  /** Partition/row keys per gym-tracker-spec.md §"Azure Table Storage mapping". */
  static keysFor(kind, record) {
    switch (kind) {
      case 'exercise':
        return { partitionKey: 'exercise', rowKey: record.id };
      case 'workout':
        return { partitionKey: record.date.slice(0, 7), rowKey: record.id }; // yyyy-MM
      case 'set':
        return {
          partitionKey: record.workoutId,
          rowKey: `${String(record.setNumber).padStart(4, '0')}-${record.id}`,
        };
      case 'template':
        return { partitionKey: 'template', rowKey: record.id };
      default:
        throw new Error(`Unknown record kind: ${kind}`);
    }
  }

  #notConfigured() {
    throw new Error(
      'AzureTableAdapter is not configured — Azure resources do not exist yet (Phase 2).'
    );
  }
  async push(_changes) {
    this.#notConfigured();
  }
  async pull(_since) {
    this.#notConfigured();
  }
  async status() {
    return { mode: 'azure-tables', configured: false, lastError: 'not configured (Phase 2)' };
  }
}

/** The active adapter. Phase 1 ships local-only. */
export function getActiveAdapter() {
  return new LocalNoopAdapter();
}
