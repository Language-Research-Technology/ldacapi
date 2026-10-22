import type { Adapter, AdapterPayload } from 'oidc-provider';
import type { Prisma } from '../generated/prisma/client.ts';
import { prisma } from '../prisma.ts';

const unexpired = () => ({ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] });

type Row = { payload: Prisma.JsonValue; consumedAt: Date | null };

const toPayload = (row: Row | null): AdapterPayload | undefined => {
  if (!row) {
    return undefined;
  }
  const payload = row.payload as AdapterPayload;
  return row.consumedAt ? { ...payload, consumed: Math.floor(row.consumedAt.getTime() / 1000) } : payload;
};

export class PrismaAdapter implements Adapter {
  private readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number) {
    const data = {
      payload: payload as Prisma.InputJsonObject,
      grantId: payload.grantId ?? null,
      userCode: payload.userCode ?? null,
      uid: payload.uid ?? null,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
      consumedAt: null,
    };
    await prisma.oidcPayload.upsert({
      where: { model_id: { model: this.model, id } },
      create: { model: this.model, id, ...data },
      update: data,
    });
  }

  async find(id: string) {
    return toPayload(await prisma.oidcPayload.findFirst({ where: { model: this.model, id, ...unexpired() } }));
  }

  async findByUid(uid: string) {
    return toPayload(await prisma.oidcPayload.findFirst({ where: { model: this.model, uid, ...unexpired() } }));
  }

  async findByUserCode(userCode: string) {
    return toPayload(await prisma.oidcPayload.findFirst({ where: { model: this.model, userCode, ...unexpired() } }));
  }

  async consume(id: string) {
    await prisma.oidcPayload.updateMany({ where: { model: this.model, id }, data: { consumedAt: new Date() } });
  }

  async destroy(id: string) {
    await prisma.oidcPayload.deleteMany({ where: { model: this.model, id } });
  }

  async revokeByGrantId(grantId: string) {
    await prisma.oidcPayload.deleteMany({ where: { model: this.model, grantId } });
  }
}
