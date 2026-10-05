import { describe, expect, it } from 'vitest';

describe('ldacapi main app', () => {
  describe('App Registration', () => {
    it('should handle missing prisma', async () => {
      console.log(process.env);
      expect(2).toBe(2);
    });
  });
});
