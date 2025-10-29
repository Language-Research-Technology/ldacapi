import { getPrismaClient } from '../common/utils';

export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  uptime: number;
  database: {
    connected: boolean;
  };
}

export class HealthService {
  async checkHealth(): Promise<HealthStatus> {
    const databaseConnected = await this.checkDatabase();

    return {
      status: databaseConnected ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: {
        connected: databaseConnected,
      },
    };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      const prisma = getPrismaClient();
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}

export const healthService = new HealthService();
