import { Collection, Db, MongoClient } from 'mongodb';
import type { Alert, NewAlert } from '../domain/alert.js';
import type { AlertRepository, Logger } from '../application/ports.js';

interface AlertDocument {
  id: number;
  chatId: string;
  assetType: Alert['assetType'];
  symbol: string;
  direction: Alert['direction'];
  targetPrice: number;
  status: Alert['status'];
  createdAt: Date;
  claimedAt: Date | null;
  triggeredAt: Date | null;
}

interface CounterDocument {
  _id: 'alerts';
  value: number;
}

export class MongoAlertRepository implements AlertRepository {
  private readonly client: MongoClient;
  private db: Db | undefined;
  private alerts: Collection<AlertDocument> | undefined;
  private counters: Collection<CounterDocument> | undefined;

  constructor(
    private readonly uri: string,
    private readonly databaseName: string,
    private readonly logger: Logger,
  ) {
    this.client = new MongoClient(uri);
  }

  async connect(): Promise<void> {
    this.logger.info('mongodb_connecting', { database: this.databaseName });
    await this.client.connect();
    this.db = this.client.db(this.databaseName);
    this.alerts = this.db.collection<AlertDocument>('alerts');
    this.counters = this.db.collection<CounterDocument>('counters');
    await Promise.all([
      this.alerts.createIndex({ id: 1 }, { unique: true }),
      this.alerts.createIndex({ symbol: 1, status: 1 }),
      this.alerts.createIndex({ chatId: 1, id: -1 }),
    ]);
    this.logger.info('mongodb_connected', { database: this.databaseName, collection: 'alerts' });
  }

  async create(input: NewAlert): Promise<Alert> {
    const alerts = this.collection();
    const counters = this.counterCollection();
    const sequence = await counters.findOneAndUpdate(
      { _id: 'alerts' },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: 'after' },
    );
    if (!sequence) throw new Error('Could not allocate an alert ID');

    const document: AlertDocument = {
      id: sequence.value,
      chatId: input.chatId,
      assetType: input.assetType,
      symbol: input.symbol,
      direction: input.direction,
      targetPrice: input.targetPrice,
      status: 'active',
      createdAt: new Date(),
      claimedAt: null,
      triggeredAt: null,
    };
    await alerts.insertOne(document);
    this.logger.info('alert_persisted', { alertId: document.id, symbol: document.symbol, assetType: document.assetType });
    return mapAlert(document);
  }

  async listByChat(chatId: string): Promise<Alert[]> {
    return (await this.collection().find({ chatId }).sort({ id: -1 }).toArray()).map(mapAlert);
  }

  async deleteByChatAndId(chatId: string, id: number): Promise<boolean> {
    const result = await this.collection().deleteOne({ chatId, id });
    this.logger.info('alert_deleted', { alertId: id, deleted: result.deletedCount > 0 });
    return result.deletedCount > 0;
  }

  async listActiveSymbols(): Promise<string[]> {
    return this.collection().distinct('symbol', { status: 'active' });
  }

  async findActiveBySymbol(symbol: string): Promise<Alert[]> {
    return (await this.collection().find({ symbol, status: 'active' }).sort({ id: 1 }).toArray()).map(mapAlert);
  }

  async claim(id: number, now: string): Promise<boolean> {
    const result = await this.collection().updateOne(
      { id, status: 'active' },
      { $set: { status: 'notifying', claimedAt: new Date(now) } },
    );
    return result.modifiedCount > 0;
  }

  async markTriggered(id: number, triggeredAt: string): Promise<void> {
    await this.collection().updateOne(
      { id, status: 'notifying' },
      { $set: { status: 'triggered', triggeredAt: new Date(triggeredAt) }, $unset: { claimedAt: '' } },
    );
  }

  async releaseClaim(id: number): Promise<void> {
    await this.collection().updateOne(
      { id, status: 'notifying' },
      { $set: { status: 'active' }, $unset: { claimedAt: '' } },
    );
  }

  async releaseStaleClaims(before: string): Promise<void> {
    await this.collection().updateMany(
      { status: 'notifying', claimedAt: { $lt: new Date(before) } },
      { $set: { status: 'active' }, $unset: { claimedAt: '' } },
    );
  }

  async close(): Promise<void> {
    await this.client.close();
    this.logger.info('mongodb_closed', { database: this.databaseName });
  }

  private collection(): Collection<AlertDocument> {
    if (!this.alerts) throw new Error('MongoAlertRepository is not connected');
    return this.alerts;
  }

  private counterCollection(): Collection<CounterDocument> {
    if (!this.counters) throw new Error('MongoAlertRepository is not connected');
    return this.counters;
  }
}

function mapAlert(document: AlertDocument): Alert {
  return {
    id: document.id,
    chatId: document.chatId,
    assetType: document.assetType,
    symbol: document.symbol,
    direction: document.direction,
    targetPrice: document.targetPrice,
    status: document.status,
    createdAt: document.createdAt.toISOString(),
    claimedAt: document.claimedAt?.toISOString() ?? null,
    triggeredAt: document.triggeredAt?.toISOString() ?? null,
  };
}
