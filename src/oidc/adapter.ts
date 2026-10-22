import { type Adapter, type AdapterPayload, errors } from 'oidc-provider';
import type { Prisma } from '../generated/prisma/client.ts';
import { prisma } from '../prisma.ts';

/** Deletes every expired model instance */
export const deleteExpired = () => prisma.oidcPayload.deleteMany({ where: { expiresAt: { lt: new Date() } } });

const toRow = (payload: AdapterPayload, expiresIn?: number) => ({
  payload: payload as Prisma.InputJsonObject,
  grantId: payload.grantId ?? null,
  uid: payload.uid ?? null,
  expiresAt: expiresIn === undefined ? null : new Date(Date.now() + expiresIn * 1000),
  consumedAt: null,
});

export class PrismaAdapter implements Adapter {
  private readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number) {
    const data = toRow(payload, expiresIn);
    await prisma.oidcPayload.upsert({
      where: { model_id: { model: this.model, id } },
      create: { model: this.model, id, ...data },
      update: data,
    });
  }

  /** Stores `payload` unless `id` already has one, and returns whichever is stored */
  async findOrInsert(id: string, payload: AdapterPayload, expiresIn?: number) {
    await prisma.oidcPayload.createMany({ data: { model: this.model, id, ...toRow(payload, expiresIn) }, skipDuplicates: true });
    return this.find(id);
  }

  find(id: string) {
    return this.findBy({ id });
  }

  findByUid(uid: string) {
    return this.findBy({ uid });
  }

  // The device flow, the only user of user codes, is off
  async findByUserCode(_userCode: string) {
    return undefined;
  }

  async consume(id: string) {
    const { count } = await prisma.oidcPayload.updateMany({ where: { model: this.model, id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (count === 0) {
      throw new errors.InvalidGrant(`${this.model} already consumed`);
    }
  }

  async destroy(id: string) {
    await prisma.oidcPayload.deleteMany({ where: { model: this.model, id } });
  }

  async revokeByGrantId(grantId: string) {
    await prisma.oidcPayload.deleteMany({ where: { model: this.model, grantId } });
  }

  private async findBy(where: { id: string } | { uid: string }): Promise<AdapterPayload | undefined> {
    const row = await prisma.oidcPayload.findFirst({
      where: { model: this.model, ...where, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    });
    if (!row) {
      return undefined;
    }
    const payload = row.payload as AdapterPayload;
    return row.consumedAt ? { ...payload, consumed: Math.floor(row.consumedAt.getTime() / 1000) } : payload;
  }
}
