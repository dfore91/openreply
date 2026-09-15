import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/app/generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createPrismaClient() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  // The pg driver ignores Prisma's `?schema=` query param, so a non-public schema
  // has to be passed to the adapter explicitly (self-hosted: the app shares a
  // database with other services and lives in its own schema).
  const schema = (() => {
    try {
      return new URL(databaseUrl).searchParams.get("schema") ?? undefined;
    } catch {
      return undefined;
    }
  })();

  return new PrismaClient({
    adapter: new PrismaPg(databaseUrl, schema ? { schema } : undefined),
  });
}

export function getPrisma(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient();
  }

  return globalForPrisma.prisma;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getPrisma(), prop, receiver);
  },
});
